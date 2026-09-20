import express from 'express'
import cors from 'cors'
import Stripe from 'stripe'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { getUsage, incrementUsage, setPlan, getPlanForInstall, usageStoreStatus, initUsageStore } from './usage-store.js'

const app = express()
const PORT = process.env.PORT || 3000

// Generic upstream LLM config — defaults to Cerebras's free tier (OpenAI-compatible,
// supports tool calling) so this can be swapped back to OpenRouter/a paid provider
// later just by changing env vars, no code changes needed.
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.cerebras.ai/v1/chat/completions'
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.CEREBRAS_API_KEY
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null

// Vision fallback — a separate, always-paid-tier provider since Cerebras's free
// models are text-only. Used only when DOM-selector clicking can't find something
// (canvas apps, custom-drawn UI). Kept as its own provider config so it can point
// at any OpenAI-vision-compatible endpoint independent of the main chat provider.
const VISION_BASE_URL = process.env.VISION_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions'
const VISION_API_KEY = process.env.VISION_API_KEY
const VISION_MODEL = process.env.VISION_MODEL || 'openai/gpt-4o-mini'

// Optional — TypeSafe's Jev, used for the agent's fast "what next?" decision.
// Leave unset to keep decision mode off; the client falls back to the chat model.
const JEV_BASE_URL = process.env.JEV_BASE_URL || 'https://api.typesafe.ai/v1/systemone'
const JEV_API_KEY = process.env.TYPESAFE_API_KEY
const JEV_MODEL = process.env.JEV_MODEL || 'jev-latest'

// Older extension builds shipped model IDs the upstream provider has since retired
// (llama-3.3-70b-versatile et al.), which surfaced to users as a hard 404 on every
// message. Extensions already installed in a browser can't be updated remotely, so
// translate known-retired IDs here instead of forwarding them. Any unrecognized ID
// falls back to the default rather than failing, since this endpoint is a fixed-menu
// proxy rather than a pass-through to the provider's full catalog.
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'openai/gpt-oss-120b'
const MODEL_ALIASES = {
  'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
  'llama-3.3-70b': 'openai/gpt-oss-120b',
  'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'gpt-oss-20b': 'openai/gpt-oss-20b',
  'qwen-3-32b': 'qwen/qwen3.8-27b',
  'qwen3-32b': 'qwen/qwen3.8-27b',
}
const ALLOWED_MODELS = new Set([
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'allam-2-7b',
  'groq/compound',
])

function resolveModel(requested) {
  if (typeof requested !== 'string' || !requested) return DEFAULT_MODEL
  if (ALLOWED_MODELS.has(requested)) return requested
  return MODEL_ALIASES[requested] || DEFAULT_MODEL
}

// ---- Usage accounting ----
//
// The agent loop makes one request per tool-call round trip, so counting every
// request would charge a single user command ten times over. Charge once per
// task instead: a fresh user turn ends with a 'user' message, while each further
// round trip of the same task ends with the 'tool' result it just appended. So
// only a transcript ending in a user message opens a new task. (The client doesn't
// send a conversation id, so the transcript shape is the signal available.)
//
// The same transcript can also arrive twice in a row when the client's streaming
// attempt fails and it retries without streaming, so remember what was just
// charged and treat an identical retry as the same task.
const RETRY_WINDOW_MS = 60 * 1000
const recentCharges = new Map()

// Hash the whole transcript, not just the opening message: two different turns in
// the same conversation share a first user message, but a retry resends the exact
// same array, so only an identical resend should collapse.
function transcriptFingerprint(installId, messages) {
  return createHash('sha256')
    .update(`${installId}\u0000${JSON.stringify(messages ?? [])}`)
    .digest('hex')
}

function opensNewTask(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return true
  return messages[messages.length - 1]?.role === 'user'
}

/** True when this request should consume one unit of the caller's quota */
function shouldChargeRequest(installId, messages) {
  if (!opensNewTask(messages)) return false

  const fingerprint = transcriptFingerprint(installId, messages)
  const chargedAt = recentCharges.get(fingerprint)
  if (chargedAt && Date.now() - chargedAt < RETRY_WINDOW_MS) return false

  recentCharges.set(fingerprint, Date.now())
  return true
}

/** Drop expired fingerprints so the map doesn't grow without bound */
function pruneRecentCharges() {
  const cutoff = Date.now() - RETRY_WINDOW_MS
  for (const [fingerprint, chargedAt] of recentCharges) {
    if (chargedAt < cutoff) recentCharges.delete(fingerprint)
  }
}
setInterval(pruneRecentCharges, RETRY_WINDOW_MS).unref()

// Plan limits — tasks (one user command, however many tool round trips it needs)
// per rolling 30-day period.
const PLAN_LIMITS = {
  free: { label: 'Free', monthlyActions: 10, priceId: null, visionFallback: false },
  plus: { label: 'Plus', monthlyActions: 150, priceId: process.env.STRIPE_PRICE_PLUS || null, visionFallback: false },
  pro: { label: 'Pro', monthlyActions: 400, priceId: process.env.STRIPE_PRICE_PRO || null, visionFallback: false },
  pro_plus: { label: 'Pro+', monthlyActions: 1000, priceId: process.env.STRIPE_PRICE_PROPLUS || null, visionFallback: true },
}

app.use(cors())

// Stripe webhooks need the raw body for signature verification, so this route
// is registered BEFORE the global json() body parser below.
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe is not configured on this server.')
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const installId = session.client_reference_id
      const plan = session.metadata?.plan
      if (installId && (plan === 'plus' || plan === 'pro' || plan === 'pro_plus')) {
        await setPlan(installId, plan, session.subscription, session.customer)
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object
      await setPlan(null, 'free', null, null, subscription.id) // revert by subscription id lookup
    }
  } catch (err) {
    console.error('Error handling webhook event:', err)
  }

  res.json({ received: true })
})

app.use(express.json({ limit: '2mb' }))

// Including the usage-store driver makes a misconfigured deploy visible from
// outside, instead of only in the Render logs.
app.get('/health', (_req, res) => res.json({ ok: true, usageStore: usageStoreStatus() }))

/** Current plan + usage for an install — the extension polls this to show "X of Y tasks used" */
app.get('/usage', async (req, res) => {
  const installId = req.header('x-install-id')
  if (!installId) return res.status(400).json({ error: 'Missing X-Install-Id header' })
  const usage = await getUsage(installId)
  const plan = PLAN_LIMITS[usage.plan] || PLAN_LIMITS.free
  res.json({
    plan: usage.plan,
    planLabel: plan.label,
    used: usage.count,
    limit: plan.monthlyActions === Infinity ? null : plan.monthlyActions,
    periodStart: usage.periodStart,
  })
})

/** Create a Stripe Checkout session for upgrading to a paid plan */
app.post('/billing/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Billing is not configured on this server yet.' })

  const installId = req.header('x-install-id')
  const { plan } = req.body
  if (!installId) return res.status(400).json({ error: 'Missing X-Install-Id header' })
  if (!['plus', 'pro', 'pro_plus'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' })

  const priceId = PLAN_LIMITS[plan].priceId
  if (!priceId) {
    return res.status(500).json({ error: `No Stripe price configured for the "${plan}" plan yet.` })
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: installId,
      metadata: { plan, installId },
      success_url: process.env.CHECKOUT_SUCCESS_URL || 'https://example.com/success',
      cancel_url: process.env.CHECKOUT_CANCEL_URL || 'https://example.com/cancel',
    })
    res.json({ url: session.url })
  } catch (err) {
    console.error('Stripe checkout error:', err)
    res.status(500).json({ error: 'Could not create checkout session.' })
  }
})

/**
 * Vision fallback — locates an element by natural-language description using a
 * vision-capable model, for pages where DOM-selector clicking can't find anything
 * (canvas apps, custom-drawn UI). Gated to plans that include it (Pro+ by default).
 */
app.post('/v1/vision-locate', async (req, res) => {
  const installId = req.header('x-install-id')
  if (!installId) return res.status(400).json({ error: { message: 'Missing X-Install-Id header.' } })

  const plan = await getPlanForInstall(installId)
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free
  if (!limits.visionFallback) {
    return res.status(402).json({
      error: {
        message: `Vision fallback isn't included in the ${limits.label} plan. Upgrade to Pro+ to enable it.`,
        code: 'VISION_REQUIRES_UPGRADE',
      },
    })
  }

  if (!VISION_API_KEY) {
    return res.status(500).json({ error: { message: 'Server is not configured with a vision API key.' } })
  }

  const { imageDataUrl, description } = req.body
  if (!imageDataUrl || !description) {
    return res.status(400).json({ error: { message: 'Missing imageDataUrl or description.' } })
  }

  let upstream
  try {
    upstream = await fetch(VISION_BASE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VISION_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `Find the on-screen element described as: "${description}". ` +
                  'Look at the attached screenshot and reply with ONLY compact JSON, no markdown, no explanation: ' +
                  '{"found": boolean, "x": <pixel center x>, "y": <pixel center y>, "label": "<short text/description of what is actually there>"}. ' +
                  'Coordinates must be pixel positions matching the exact width/height of the attached image.',
              },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    })
  } catch (err) {
    console.error('Vision upstream fetch failed:', err)
    return res.status(502).json({ error: { message: 'Could not reach the vision provider.' } })
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    return res.status(upstream.status).json({ error: { message: `Vision provider error: ${text}` } })
  }

  const data = await upstream.json()
  const raw = data?.choices?.[0]?.message?.content || ''
  const cleaned = raw.replace(/```json|```/g, '').trim()

  try {
    const parsed = JSON.parse(cleaned)
    return res.json(parsed)
  } catch {
    console.error('Could not parse vision model response:', raw)
    return res.json({ found: false })
  }
})

/**
 * Fast decision endpoint backed by TypeSafe's Jev (a "System One" model). Jev
 * does not generate text — it picks one option from a set you declare and
 * returns calibrated probabilities, which makes it far cheaper and faster than
 * a chat model for the agent's "what do I do next?" step.
 *
 * The extension decides when to use this; the backend only proxies. When no key
 * is configured the endpoint reports 501 so the client can fall back to the
 * chat model instead of the user hitting an error.
 */
app.post('/v1/decide', async (req, res) => {
  const installId = req.header('x-install-id')
  if (!installId) return res.status(400).json({ error: { message: 'Missing X-Install-Id header.' } })

  if (!JEV_API_KEY) {
    return res.status(501).json({
      error: {
        message: 'Fast decision mode is not configured on this server.',
        code: 'JEV_NOT_CONFIGURED',
      },
    })
  }

  const { state, question, options } = req.body ?? {}
  if (!state || !question || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({
      error: { message: 'Requires state, question, and at least two options.' },
    })
  }

  let upstream
  try {
    upstream = await fetch(JEV_BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${JEV_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state,
        questions: {
          next: {
            type: 'choice',
            instructions: question,
            // Jev answers with one of these labels, so no JSON parsing is needed.
            criteria: Object.fromEntries(options.map((option) => [option, option])),
          },
        },
      }),
    })
  } catch (err) {
    console.error('Jev upstream fetch failed:', err)
    return res.status(502).json({ error: { message: 'Could not reach the decision provider.' } })
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    console.error(`Jev upstream ${upstream.status}:`, text.slice(0, 500))
    // 429 is Jev's rate limit; the client should retry against the chat model.
    return res.status(upstream.status === 429 ? 503 : 502).json({
      error: { message: `Decision provider error (${upstream.status}).`, code: 'JEV_UPSTREAM_ERROR' },
    })
  }

  const data = await upstream.json()
  const answer = data?.answers?.next
  const choice = answer?.choice

  if (!choice || !options.includes(choice)) {
    console.error('Unexpected Jev response shape:', JSON.stringify(data).slice(0, 500))
    return res.status(502).json({ error: { message: 'Decision provider returned an unusable answer.', code: 'JEV_BAD_ANSWER' } })
  }

  res.json({ choice, confidence: answer?.confidence ?? null, model: data?.model ?? JEV_MODEL })
})

/** Cheap probe so the extension can feature-detect decision mode once per session */
app.get('/v1/decide/available', (_req, res) => res.json({ available: Boolean(JEV_API_KEY) }))

/**
 * The core proxy: forwards chat completion requests to OpenRouter using our own
 * server-held key, after checking the caller hasn't exceeded their plan's limit.
 * Request/response shape is passed through untouched (including streaming), so
 * the extension's existing OpenAI-compatible client needs no format changes —
 * only the URL and the removal of a client-side key.
 */
app.post('/v1/chat/completions', async (req, res) => {
  const installId = req.header('x-install-id')
  const userKey = req.header('x-user-llm-key') // optional BYOK escape hatch

  if (!installId && !userKey) {
    return res.status(400).json({ error: { message: 'Missing X-Install-Id header.' } })
  }

  let authKey = LLM_API_KEY

  if (userKey) {
    // Power users who bring their own OpenRouter key skip our limits entirely.
    authKey = userKey
  } else {
    const plan = await getPlanForInstall(installId)
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free
    const usage = await getUsage(installId)

    // Checked on every request so a mid-task loop can't run past the limit, but
    // only a new task actually consumes quota.
    if (usage.count >= limits.monthlyActions) {
      return res.status(429).json({
        error: {
          message: `You've used all ${limits.monthlyActions} tasks on the ${limits.label} plan this period. Upgrade for more.`,
          code: 'PLAN_LIMIT_REACHED',
        },
      })
    }

    if (shouldChargeRequest(installId, req.body?.messages)) {
      await incrementUsage(installId)
    }
  }

  if (!authKey) {
    return res.status(500).json({ error: { message: 'Server is not configured with an LLM API key.' } })
  }

  let upstream
  try {
    const resolvedModel = resolveModel(req.body?.model)
    if (resolvedModel !== req.body?.model) {
      console.log(`[model] ${req.body?.model ?? '(none)'} -> ${resolvedModel}`)
    }
    upstream = await fetch(LLM_BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...req.body, model: resolvedModel }),
    })
  } catch (err) {
    console.error('Upstream fetch failed:', err)
    return res.status(502).json({ error: { message: 'Could not reach the LLM provider.' } })
  }

  res.status(upstream.status)
  for (const [key, value] of upstream.headers.entries()) {
    // Let Express/Node manage these itself
    if (['content-encoding', 'content-length', 'connection'].includes(key.toLowerCase())) continue
    res.setHeader(key, value)
  }

  if (!upstream.body) {
    return res.end()
  }

  Readable.fromWeb(upstream.body).pipe(res)
})

app.listen(PORT, async () => {
  console.log(`ClickyWeb backend listening on port ${PORT}`)
  await initUsageStore()
})

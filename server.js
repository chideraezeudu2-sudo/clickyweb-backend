import express from 'express'
import cors from 'cors'
import Stripe from 'stripe'
import { Readable } from 'node:stream'
import { getUsage, incrementUsage, setPlan, getPlanForInstall } from './usage-store.js'

const app = express()
const PORT = process.env.PORT || 3000

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null

// Plan limits — actions (agent tool-calls/messages) per rolling 30-day period.
// Matches the pricing tiers from the original pitch: Free / Basic Pro / Power Agent.
const PLAN_LIMITS = {
  free: { label: 'Free', monthlyActions: 5, priceId: null },
  basic: { label: 'Basic Pro', monthlyActions: 150, priceId: process.env.STRIPE_PRICE_BASIC || null },
  power: { label: 'Power Agent', monthlyActions: Infinity, priceId: process.env.STRIPE_PRICE_POWER || null },
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
      if (installId && (plan === 'basic' || plan === 'power')) {
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

app.get('/health', (_req, res) => res.json({ ok: true }))

/** Current plan + usage for an install — the extension polls this to show "X of Y actions used" */
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
  if (plan !== 'basic' && plan !== 'power') return res.status(400).json({ error: 'Invalid plan' })

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
 * The core proxy: forwards chat completion requests to OpenRouter using our own
 * server-held key, after checking the caller hasn't exceeded their plan's limit.
 * Request/response shape is passed through untouched (including streaming), so
 * the extension's existing OpenAI-compatible client needs no format changes —
 * only the URL and the removal of a client-side key.
 */
app.post('/v1/chat/completions', async (req, res) => {
  const installId = req.header('x-install-id')
  const userKey = req.header('x-user-openrouter-key') // optional BYOK escape hatch

  if (!installId && !userKey) {
    return res.status(400).json({ error: { message: 'Missing X-Install-Id header.' } })
  }

  let authKey = OPENROUTER_API_KEY

  if (userKey) {
    // Power users who bring their own OpenRouter key skip our limits entirely.
    authKey = userKey
  } else {
    const plan = await getPlanForInstall(installId)
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free
    const usage = await getUsage(installId)

    if (usage.count >= limits.monthlyActions) {
      return res.status(429).json({
        error: {
          message: `You've used all ${limits.monthlyActions} actions on the ${limits.label} plan this period. Upgrade for more.`,
          code: 'PLAN_LIMIT_REACHED',
        },
      })
    }

    await incrementUsage(installId)
  }

  if (!authKey) {
    return res.status(500).json({ error: { message: 'Server is not configured with an OpenRouter API key.' } })
  }

  let upstream
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://clickyweb.app',
        'X-Title': 'ClickyWeb',
      },
      body: JSON.stringify(req.body),
    })
  } catch (err) {
    console.error('Upstream fetch failed:', err)
    return res.status(502).json({ error: { message: 'Could not reach OpenRouter.' } })
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

app.listen(PORT, () => {
  console.log(`ClickyWeb backend listening on port ${PORT}`)
})

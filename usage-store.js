import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const TABLE = 'clickyweb_usage'
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null

if (!supabase) {
  console.warn(
    '[usage-store] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using an in-memory usage store. ' +
      'Fine for local testing, but counts reset on every restart/deploy. Set those env vars before real launch.'
  )
}

// Credentials can be present while the table is still missing — for example when
// the env vars are set before the schema is created. Branching on those credentials
// alone would then fail every request, so decide on first use instead and fall back
// to memory (loudly) rather than taking the API down.
let useSupabase = supabase !== null
let supabaseDisabledReason = null

function disableSupabase(reason, err) {
  if (!useSupabase) return
  useSupabase = false
  supabaseDisabledReason = reason
  console.error(
    `[usage-store] Falling back to the in-memory store: ${reason}. ` +
      'Plan limits will not persist across restarts until this is fixed.' +
      (err ? ` (${err.message || err})` : '')
  )
}

/** In-memory fallback store, keyed by install id */
const memoryStore = new Map()

function freshRecord() {
  return { plan: 'free', count: 0, periodStart: new Date().toISOString(), stripeSubscriptionId: null, stripeCustomerId: null }
}

function isExpired(periodStart) {
  return Date.now() - new Date(periodStart).getTime() > PERIOD_MS
}

// ---- In-memory implementation ----

function memGetUsage(installId) {
  let record = memoryStore.get(installId)
  if (!record) {
    record = freshRecord()
    memoryStore.set(installId, record)
  }
  if (isExpired(record.periodStart)) {
    record.count = 0
    record.periodStart = new Date().toISOString()
  }
  return record
}

function memIncrementUsage(installId) {
  const record = memGetUsage(installId)
  record.count += 1
}

function memSetPlan(installId, plan, subscriptionId, customerId, bySubscriptionId) {
  if (bySubscriptionId) {
    for (const record of memoryStore.values()) {
      if (record.stripeSubscriptionId === bySubscriptionId) {
        record.plan = plan
      }
    }
    return
  }
  const record = memGetUsage(installId)
  record.plan = plan
  record.stripeSubscriptionId = subscriptionId
  record.stripeCustomerId = customerId
}

// ---- Supabase implementation ----
// Expected table (run once in the Supabase SQL editor):
//
// create table clickyweb_usage (
//   install_id text primary key,
//   plan text not null default 'free',
//   count int not null default 0,
//   period_start timestamptz not null default now(),
//   stripe_subscription_id text,
//   stripe_customer_id text
// );

async function sbGetUsage(installId) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('install_id', installId).maybeSingle()
  if (error) throw error

  if (!data) {
    const fresh = freshRecord()
    await supabase.from(TABLE).insert({
      install_id: installId,
      plan: fresh.plan,
      count: fresh.count,
      period_start: fresh.periodStart,
    })
    return fresh
  }

  if (isExpired(data.period_start)) {
    const resetAt = new Date().toISOString()
    await supabase.from(TABLE).update({ count: 0, period_start: resetAt }).eq('install_id', installId)
    return { plan: data.plan, count: 0, periodStart: resetAt, stripeSubscriptionId: data.stripe_subscription_id, stripeCustomerId: data.stripe_customer_id }
  }

  return {
    plan: data.plan,
    count: data.count,
    periodStart: data.period_start,
    stripeSubscriptionId: data.stripe_subscription_id,
    stripeCustomerId: data.stripe_customer_id,
  }
}

async function sbIncrementUsage(installId) {
  const usage = await sbGetUsage(installId)
  await supabase.from(TABLE).update({ count: usage.count + 1 }).eq('install_id', installId)
}

async function sbSetPlan(installId, plan, subscriptionId, customerId, bySubscriptionId) {
  if (bySubscriptionId) {
    await supabase.from(TABLE).update({ plan }).eq('stripe_subscription_id', bySubscriptionId)
    return
  }
  await sbGetUsage(installId) // ensure row exists
  await supabase
    .from(TABLE)
    .update({ plan, stripe_subscription_id: subscriptionId, stripe_customer_id: customerId })
    .eq('install_id', installId)
}

// ---- Public API (picks the backing store automatically) ----

/**
 * Probe the backing table once at startup so /health reports the store actually
 * in use rather than just whether credentials are present. Without this the
 * service looks persistent until the first request happens to fail over.
 */
export async function initUsageStore() {
  if (!useSupabase) return usageStoreStatus()

  try {
    await sbGetUsage('__startup_probe__')
    console.log(`[usage-store] Using Supabase table '${TABLE}'. Usage will persist across deploys.`)
  } catch (err) {
    const message = err?.message || String(err)
    const isMissingSchema = /schema cache|does not exist|relation .* does not exist/i.test(message)
    const isBadCredentials = /JWT|invalid api key|Unauthorized|401/i.test(message)

    if (isMissingSchema || isBadCredentials) {
      disableSupabase(
        isMissingSchema ? `table '${TABLE}' is not available` : 'Supabase credentials were rejected',
        err
      )
    } else {
      console.error('[usage-store] Startup probe failed, will retry on first request:', message)
    }
  }

  return usageStoreStatus()
}

/**
 * Run a Supabase-backed operation, falling back to the in-memory store if the
 * backing table is unusable. Only infrastructure errors (missing table, bad
 * credentials) permanently trigger the fallback — a transient per-call error
 * serves from memory once but leaves the next call to try Supabase again.
 */
async function withStore(supabaseOp, memoryOp, label) {
  if (!useSupabase) return memoryOp()

  try {
    return await supabaseOp()
  } catch (err) {
    const message = err?.message || String(err)
    const isMissingSchema = /schema cache|does not exist|relation .* does not exist/i.test(message)
    const isBadCredentials = /JWT|invalid api key|Unauthorized|401/i.test(message)

    if (isMissingSchema || isBadCredentials) {
      disableSupabase(
        isMissingSchema ? `table '${TABLE}' is not available` : 'Supabase credentials were rejected',
        err
      )
    } else {
      console.error(`[usage-store] ${label} failed, serving from memory for this call:`, message)
    }
    return memoryOp()
  }
}

export async function getUsage(installId) {
  return withStore(() => sbGetUsage(installId), () => memGetUsage(installId), 'getUsage')
}

export async function incrementUsage(installId) {
  return withStore(() => sbIncrementUsage(installId), () => memIncrementUsage(installId), 'incrementUsage')
}

export async function setPlan(installId, plan, subscriptionId, customerId, bySubscriptionId) {
  return withStore(
    () => sbSetPlan(installId, plan, subscriptionId, customerId, bySubscriptionId),
    () => memSetPlan(installId, plan, subscriptionId, customerId, bySubscriptionId),
    'setPlan'
  )
}

export async function getPlanForInstall(installId) {
  const usage = await getUsage(installId)
  return usage.plan
}

/** Reports which store is actually in use — surfaced by /health for deploys */
export function usageStoreStatus() {
  return {
    driver: useSupabase ? 'supabase' : 'memory',
    persistent: useSupabase,
    ...(supabaseDisabledReason ? { disabledReason: supabaseDisabledReason } : {}),
  }
}

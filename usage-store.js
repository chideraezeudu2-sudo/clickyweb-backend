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

export async function getUsage(installId) {
  return supabase ? sbGetUsage(installId) : memGetUsage(installId)
}

export async function incrementUsage(installId) {
  return supabase ? sbIncrementUsage(installId) : memIncrementUsage(installId)
}

export async function setPlan(installId, plan, subscriptionId, customerId, bySubscriptionId) {
  return supabase ? sbSetPlan(installId, plan, subscriptionId, customerId, bySubscriptionId) : memSetPlan(installId, plan, subscriptionId, customerId, bySubscriptionId)
}

export async function getPlanForInstall(installId) {
  const usage = await getUsage(installId)
  return usage.plan
}

// This file configures the initialization of Sentry on the client.
// The config you add here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs'
import { match } from 'path-to-regexp'

import { hasConsented } from 'common'
import { IS_PLATFORM } from 'common/constants/environment'
import { MIRRORED_BREADCRUMBS } from 'lib/breadcrumbs'
import { sanitizeArrayOfObjects, sanitizeUrlHashParams } from 'lib/sanitize'

// This is a workaround to ignore hCaptcha related errors.
function isHCaptchaRelatedError(event: Sentry.Event): boolean {
  const errors = event.exception?.values ?? []
  for (const error of errors) {
    if (
      error.value?.includes('is not a function') &&
      error.stacktrace?.frames?.some((f) => f.filename === 'api.js')
    ) {
      return true
    }
  }
  return false
}

// We want to ignore errors not originating from docs app static files
// (such as errors from browser extensions). Those errors come from files
// not starting with 'app:///_next'.
//
// However, there is a complication because the Sentry code that sends
// the error shows up in the stack trace, and that _does_ start with
// 'app:///_next'. It is always the first frame in the stack trace,
// and has a specific pre_context comment that we can use for filtering.
// Copied from docs app instrumentation-client.ts
function isThirdPartyError(frames: Sentry.StackFrame[] | undefined) {
  if (!frames || frames.length === 0) return false

  function isSentryFrame(frame: Sentry.StackFrame, index: number) {
    return index === 0 && frame.pre_context?.some((line) => line.includes('sentry.javascript'))
  }

  // Check if any frame is from our app (excluding Sentry's own frame)
  const hasAppFrame = frames.some((frame, index) => {
    const path = frame.abs_path || frame.filename
    return path?.startsWith('app:///_next') && !isSentryFrame(frame, index)
  })

  // If no app frames found, it's a third-party error
  return !hasAppFrame
}

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  ...(process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT && {
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  }),
  // Setting this option to true will print useful information to the console while you're setting up Sentry.
  debug: false,

  // Enable performance monitoring - Next.js routes and API calls are automatically instrumented
  tracesSampleRate: 0.1, // Capture 10% of transactions for performance monitoring

  // [Ali] Filter out browser extensions and user scripts (FE-2094)
  // Using denyUrls to block known third-party script patterns
  denyUrls: [/userscript/i],
  beforeBreadcrumb(breadcrumb, _hint) {
    const cleanedBreadcrumb = { ...breadcrumb }

    if (cleanedBreadcrumb.category === 'navigation') {
      if (typeof cleanedBreadcrumb.data?.from === 'string') {
        cleanedBreadcrumb.data.from = sanitizeUrlHashParams(cleanedBreadcrumb.data.from)
      }
      if (typeof cleanedBreadcrumb.data?.to === 'string') {
        cleanedBreadcrumb.data.to = sanitizeUrlHashParams(cleanedBreadcrumb.data.to)
      }
    }

    MIRRORED_BREADCRUMBS.pushBack(cleanedBreadcrumb)
    return cleanedBreadcrumb
  },
  beforeSend(event, hint) {
    const consent = hasConsented()

    if (!consent) {
      return null
    }

    if (!IS_PLATFORM) {
      return null
    }

    // Ignore invalid URL events for 99% of the time because it's using up a lot of quota.
    const isInvalidUrlEvent = (hint.originalException as any)?.message?.includes(
      `Failed to construct 'URL': Invalid URL`
    )
    // [Joshen] Similar behaviour for this error from SessionTimeoutModal to control the quota usage
    const isSessionTimeoutEvent = (hint.originalException as any)?.message?.includes(
      'Session error detected'
    )

    if ((isInvalidUrlEvent || isSessionTimeoutEvent) && Math.random() > 0.01) {
      return null
    }

    if (isHCaptchaRelatedError(event)) {
      return null
    }

    const frames = event.exception?.values?.[0].stacktrace?.frames || []
    if (isThirdPartyError(frames)) {
      return null
    }

    // Filter out errors like 'e._5BLbSXV[t] is not a function' or anything matching '[t] is not a function'
    if (
      hint.originalException instanceof Error &&
      hint.originalException.message.includes('[t] is not a function')
    ) {
      return null
    }

    if (event.breadcrumbs) {
      event.breadcrumbs = sanitizeArrayOfObjects(event.breadcrumbs) as Sentry.Breadcrumb[]
    }
    return event
  },
  ignoreErrors: [
    // === Monaco Editor ===
    'ResizeObserver',
    's.getModifierState is not a function',
    /^Uncaught NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope'/,

    // === Third-party SDK errors ===
    // stripe-js: https://github.com/stripe/stripe-js/issues/26
    'Failed to load Stripe.js',
    // hCaptcha
    "undefined is not an object (evaluating 'n.chat.setReady')",
    "undefined is not an object (evaluating 'i.chat.setReady')",

    // === Next.js internals ===
    // Ref: https://github.com/supabase/supabase/pull/9729
    /The provided `href` \(\/org\/\[slug\]\/.*\) value is missing query values/,
    // Next.js throws these during navigation, not actual errors
    'NEXT_NOT_FOUND',
    'NEXT_REDIRECT',

    // === User input errors (not bugs) ===
    // sql-formatter lexer on invalid SQL input
    /^Parse error: Unexpected ".+" at line \d+ column \d+$/,

    // === Network / infrastructure (not actionable on FE) ===
    /504 Gateway Time-out/,
    'Network request failed',
    'Failed to fetch',
    'Load failed',
    'AbortError',
    'TypeError: cancelled',
    'TypeError: Cancelled',

    // === Code-split / chunk loading (transient network issues) ===
    'ChunkLoadError',
    /Loading chunk [\d]+ failed/,
    /Loading CSS chunk [\d]+ failed/,

    // === Browser extensions & Google Translate DOM manipulation ===
    'Node.insertBefore: Child to insert before is not a child of this node',
    "NotFoundError: Failed to execute 'removeChild' on 'Node'",
    "NotFoundError: Failed to execute 'insertBefore' on 'Node'",
    "Cannot read properties of null (reading 'parentNode')",
    "Cannot read properties of null (reading 'removeChild')",
    "TypeError: can't access dead object",
    /^NS_ERROR_/,

    // === Non-Error throws (extensions, third-party libs throwing strings/objects) ===
    'Non-Error exception captured',
    'Non-Error promise rejection captured',

    // === Cross-origin script errors (no useful info) ===
    'Script error.',
    'Script error',

    // === React hydration mismatches (usually caused by extensions modifying DOM) ===
    /text content does not match/i,
    /hydration/i,
    /Hydration failed because/i,
    /There was an error while hydrating/i,

    // === Web crawler / bot errors ===
    'instantSearchSDKJSBridgeClearHighlight',

    // === Misc known noise ===
    'r.default.setDefaultLevel is not a function',
    // Clipboard permission denied
    'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.',
    // Facebook pixel
    'fb_xd_fragment',
  ],
})

// Replace dynamic query param with a template text
// Support grouping sentry transaction
function standardiseRouterUrl(url: string) {
  let finalUrl = url

  const orgMatch = match('/org/:slug{/*path}', { decode: decodeURIComponent })
  const orgMatchResult = orgMatch(finalUrl)
  if (orgMatchResult) {
    finalUrl = finalUrl.replace((orgMatchResult.params as any).slug, '[slug]')
  }

  const newOrgMatch = match('/new/:slug', { decode: decodeURIComponent })
  const newOrgMatchResult = newOrgMatch(finalUrl)
  if (newOrgMatchResult) {
    finalUrl = finalUrl.replace((newOrgMatchResult.params as any).slug, '[slug]')
  }

  const projectMatch = match('/project/:ref{/*path}', { decode: decodeURIComponent })
  const projectMatchResult = projectMatch(finalUrl)
  if (projectMatchResult) {
    finalUrl = finalUrl.replace((projectMatchResult.params as any).ref, '[ref]')
  }

  return finalUrl
}

// This export will instrument router navigations, and is only relevant if you enable tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart

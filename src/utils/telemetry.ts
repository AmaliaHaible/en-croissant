let posthogPromise: Promise<typeof import("posthog-js").default> | undefined;

export function getPostHog() {
    posthogPromise ??= import("posthog-js").then(({ default: posthog }) => {
        posthog.init("phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z", {
            api_host: "https://app.posthog.com",
            autocapture: false,
            capture_pageview: false,
            capture_pageleave: false,
            disable_session_recording: true,
        });

        return posthog;
    });

    return posthogPromise;
}

export async function setTelemetryEnabled(enabled: boolean) {
    const posthog = await getPostHog();

    if (enabled) {
        posthog.opt_in_capturing();
    } else {
        posthog.opt_out_capturing();
    }
}

// Crunchyroll Dub Finder - Background Service Worker

// Automatically captures the user's active Crunchyroll Bearer token
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (!details.requestHeaders) return;

        for (const header of details.requestHeaders) {
            if (header.name.toLowerCase() === 'authorization' && header.value && header.value.startsWith('Bearer ')) {
                chrome.storage.local.set({
                    cr_token: header.value,
                    token_updated_at: Date.now()
                });
                break;
            }
        }
    },
    { urls: ["https://*.crunchyroll.com/*"] },
    ["requestHeaders", "extraHeaders"]
);

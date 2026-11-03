// Crunchyroll Dub Finder - Content Script

(function () {
    'use strict';

    const DUBS = [
        { id: 'es-any', label: 'Spanish (Latin America & Spain)', codes: ['es-419', 'es-ES'] },
        { id: 'es-419', label: 'Spanish (Latin America)', codes: ['es-419'] },
        { id: 'es-ES', label: 'Spanish (Spain)', codes: ['es-ES'] },
        { id: 'en-US', label: 'English', codes: ['en-US'] },
        { id: 'pt-BR', label: 'Portuguese (Brazil)', codes: ['pt-BR'] },
        { id: 'fr-FR', label: 'French', codes: ['fr-FR'] },
        { id: 'de-DE', label: 'German', codes: ['de-DE'] },
        { id: 'it-IT', label: 'Italian', codes: ['it-IT'] },
        { id: 'ja-JP', label: 'Japanese', codes: ['ja-JP'] },
        { id: 'hi-IN', label: 'Hindi', codes: ['hi-IN'] },
        { id: 'ta-IN', label: 'Tamil', codes: ['ta-IN'] },
        { id: 'te-IN', label: 'Telugu', codes: ['te-IN'] },
        { id: 'ar-SA', label: 'Arabic', codes: ['ar-SA'] },
        { id: 'pl-PL', label: 'Polish', codes: ['pl-PL'] },
        { id: 'th-TH', label: 'Thai', codes: ['th-TH'] },
        { id: 'ru-RU', label: 'Russian', codes: ['ru-RU'] }
    ];

    const LOCALE_NAMES = {
        'es-419': 'Spanish (Latin America)',
        'es-ES': 'Spanish (Spain)',
        'en-US': 'English',
        'ja-JP': 'Japanese',
        'pt-BR': 'Portuguese (Brazil)',
        'fr-FR': 'French',
        'de-DE': 'German',
        'it-IT': 'Italian',
        'hi-IN': 'Hindi',
        'ta-IN': 'Tamil',
        'te-IN': 'Telugu',
        'ar-SA': 'Arabic',
        'pl-PL': 'Polish',
        'th-TH': 'Thai',
        'ru-RU': 'Russian',
        'zh-CN': 'Chinese'
    };

    function formatLocale(code) {
        return LOCALE_NAMES[code] || code;
    }

    let isScanning = false;
    let shouldStop = false;
    let matchedResults = [];
    let selectedDubId = 'es-any';
    let isMinimized = false;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Get user token captured by background service worker
    async function getUserToken() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['cr_token'], (res) => {
                resolve(res.cr_token || null);
            });
        });
    }

    // ==========================================
    // API FETCHER (/seasons -> /seasons/{id}/episodes)
    // Crunchyroll routes episodes under seasons, not series.
    // episode.versions[].audio_locale reflects real in-player dubs.
    // ==========================================
    async function fetchSeriesDubLocales(seriesId, token) {
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Authorization': token
        };

        // 1. Fetch seasons for series
        const seasonsUrl = `https://www.crunchyroll.com/content/v2/cms/series/${seriesId}/seasons?locale=en-US`;
        const seasonsRes = await fetch(seasonsUrl, { headers, credentials: 'include' });

        if (!seasonsRes.ok) {
            console.warn(`[CR Dub Finder] Seasons API error ${seasonsRes.status} for series ${seriesId}`);
            return [];
        }

        const seasonsJson = await seasonsRes.json();
        const seasons = seasonsJson.data || [];
        if (seasons.length === 0) return [];

        const detectedLocales = new Set();

        // 2. Fetch episodes for Season 1 to get exact player audio versions
        const firstSeasonId = seasons[0].id;
        const episodesUrl = `https://www.crunchyroll.com/content/v2/cms/seasons/${firstSeasonId}/episodes?locale=en-US`;
        const epRes = await fetch(episodesUrl, { headers, credentials: 'include' });

        if (epRes.ok) {
            const epJson = await epRes.json();
            const episodes = epJson.data || [];
            episodes.forEach((ep) => {
                if (Array.isArray(ep.versions)) {
                    ep.versions.forEach((v) => {
                        if (v.audio_locale) detectedLocales.add(v.audio_locale);
                    });
                } else if (ep.audio_locale) {
                    detectedLocales.add(ep.audio_locale);
                }
            });
        }

        // Fallback: If episodes returned no versions, inspect season versions
        if (detectedLocales.size === 0) {
            seasons.forEach((season) => {
                if (Array.isArray(season.versions)) {
                    season.versions.forEach((v) => {
                        if (v.audio_locale) detectedLocales.add(v.audio_locale);
                    });
                }
            });
        }

        return Array.from(detectedLocales);
    }

    // ==========================================
    // SCANNER LOGIC
    // ==========================================
    async function startScan() {
        if (isScanning) return;

        const token = await getUserToken();
        if (!token) {
            alert("⚠️ Your Crunchyroll session token hasn't been captured yet.\nPlease refresh the page so the extension can read your session token!");
            return;
        }

        const cardAnchors = document.querySelectorAll('.browse-card a[href*="/series/"], [class*="browse-card"] a[href*="/series/"], a[href*="/series/"]');
        if (!cardAnchors || cardAnchors.length === 0) {
            alert("No anime cards found on this page! Make sure you are on https://www.crunchyroll.com/videos/popular");
            return;
        }

        const currentDubObj = DUBS.find((l) => l.id === selectedDubId) || DUBS[0];
        const targetCodes = currentDubObj.codes;

        const queue = [];
        cardAnchors.forEach((anchor) => {
            const rawHref = anchor.getAttribute('href');
            if (!rawHref) return;

            const fullUrl = new URL(rawHref, window.location.origin).href;
            const match = fullUrl.match(/\/series\/([A-Za-z0-9]+)(?:\/([^/?#]+))?/);
            if (match) {
                const seriesId = match[1];
                const slug = match[2] || seriesId;

                if (!queue.some((q) => q.seriesId === seriesId)) {
                    queue.push({
                        name: slug,
                        seriesUrl: `https://www.crunchyroll.com/series/${seriesId}/${slug}`,
                        seriesId: seriesId
                    });
                }
            }
        });

        if (queue.length === 0) {
            alert("Could not extract series links.");
            return;
        }

        isScanning = true;
        shouldStop = false;
        updateUIState(true);

        let matchesFoundThisSession = 0;
        const total = queue.length;

        for (let i = 0; i < total; i++) {
            if (shouldStop) break;

            const item = queue[i];
            updateStatusText(`[${i + 1}/${total}] Checking: ${item.name}...`);

            try {
                const locales = await fetchSeriesDubLocales(item.seriesId, token);
                const hasMatch = locales.some((loc) => targetCodes.includes(loc));

                if (hasMatch) {
                    const readableDubs = locales.map(formatLocale);
                    recordMatch({
                        ...item,
                        dubs: readableDubs
                    });
                    matchesFoundThisSession++;
                    console.log(`[CR Dub Finder] ✅ MATCH (${matchesFoundThisSession}): ${item.name} -> [${readableDubs.join(', ')}]`);
                } else {
                    console.log(`[CR Dub Finder] ❌ Discarded: ${item.name} (has [${locales.join(', ')}])`);
                }
            } catch (err) {
                console.error(`[CR Dub Finder] Error checking ${item.name}:`, err);
            }

            await sleep(600);
        }

        isScanning = false;
        updateUIState(false);
        updateStatusText(shouldStop ? 'Scan paused.' : `🎉 Finished! Found ${matchesFoundThisSession} matches.`);

        if (!shouldStop && matchesFoundThisSession > 0) {
            exportCSV();
        }
    }

    function stopScan() {
        shouldStop = true;
        isScanning = false;
        updateUIState(false);
        updateStatusText('Stopping...');
    }

    function recordMatch(data) {
        const idx = matchedResults.findIndex((r) => r.seriesId === data.seriesId);
        const record = {
            name: data.name,
            dubs: (data.dubs || []).join('; '),
            seriesUrl: data.seriesUrl,
            seriesId: data.seriesId
        };

        if (idx >= 0) {
            matchedResults[idx] = record;
        } else {
            matchedResults.push(record);
        }

        chrome.storage.local.set({ matched_results: matchedResults });
        updateCountDisplay();
    }

    // ==========================================
    // CSV EXPORT (ONLY Matches: Name,Dubs,Series Link)
    // ==========================================
    function exportCSV() {
        if (matchedResults.length === 0) {
            alert("No matching anime found yet to export!");
            return;
        }

        const dubObj = DUBS.find((l) => l.id === selectedDubId) || DUBS[0];
        let csv = "Name,Dubs,Series Link\n";

        matchedResults.forEach((row) => {
            const escape = (val) => `"${(val || '').replace(/"/g, '""')}"`;
            csv += `${escape(row.name)},${escape(row.dubs)},${escape(row.seriesUrl)}\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const sanitizedDub = dubObj.label.toLowerCase().replace(/[^a-z0-9]/g, '_');
        a.download = `crunchyroll_${sanitizedDub}_anime_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ==========================================
    // FLOATING UI
    // ==========================================
    function updateStatusText(text) {
        const el = document.getElementById('cr-dub-status');
        if (el) el.textContent = text;
    }

    function updateCountDisplay() {
        const countEl = document.getElementById('cr-dub-matches-count');
        const exportBtn = document.getElementById('cr-dub-export-btn');
        if (countEl) countEl.textContent = matchedResults.length;
        if (exportBtn) exportBtn.textContent = `Download CSV (${matchedResults.length})`;
    }

    function updateUIState(running) {
        const btn = document.getElementById('cr-dub-toggle-btn');
        const badge = document.getElementById('cr-dub-badge');
        if (btn) {
            btn.textContent = running ? 'Stop Scan' : 'Start Scan';
            btn.style.background = running ? '#d32f2f' : '#ff640a';
        }
        if (badge) {
            badge.textContent = running ? 'SCANNING' : 'READY';
            badge.style.background = running ? '#2e7d32' : '#424242';
        }
    }

    async function createUI() {
        // Only display on /videos/popular
        if (!window.location.pathname.includes('/videos/popular')) {
            const existing = document.getElementById('cr-dub-widget');
            if (existing) existing.remove();
            return;
        }

        if (document.getElementById('cr-dub-widget')) return;

        // Restore saved state
        const stored = await new Promise(r => chrome.storage.local.get(['matched_results', 'selected_dub', 'cr_token'], r));
        if (stored.matched_results) matchedResults = stored.matched_results;
        if (stored.selected_dub) selectedDubId = stored.selected_dub;

        const hasToken = !!stored.cr_token;

        const panel = document.createElement('div');
        panel.id = 'cr-dub-widget';
        panel.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 2147483647;
            background: #141519;
            color: #ffffff;
            padding: 14px;
            border-radius: 10px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.85);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            width: ${isMinimized ? '220px' : '330px'};
            border: 2px solid #ff640a;
            user-select: none;
            transition: width 0.2s ease;
        `;

        const optionsHtml = DUBS.map((dub) =>
            `<option value="${dub.id}" ${dub.id === selectedDubId ? 'selected' : ''}>${dub.label}</option>`
        ).join('');

        panel.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center; gap: 8px;">
                    <span style="font-weight: bold; font-size: 14px; color: #ff640a;">CR Dub Finder</span>
                    <span id="cr-dub-badge" style="background: ${hasToken ? '#2e7d32' : '#d32f2f'}; font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px;">
                        ${hasToken ? 'READY' : 'NO TOKEN'}
                    </span>
                </div>
                <button id="cr-dub-min-btn" title="Minimize / Expand" style="background:transparent; border:none; color:#aaa; cursor:pointer; font-size:16px; font-weight:bold; padding:0 4px;">
                    ${isMinimized ? '＋' : '—'}
                </button>
            </div>

            <div id="cr-dub-body" style="display: ${isMinimized ? 'none' : 'block'}; margin-top: 10px;">
                <div style="margin-bottom: 10px;">
                    <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px; font-weight: bold;">
                        Target Dub:
                    </label>
                    <select id="cr-dub-dropdown" style="width: 100%; padding: 6px 8px; background: #23252b; color: #fff; border: 1px solid #444; border-radius: 6px; font-size: 12px; cursor: pointer; outline: none;">
                        ${optionsHtml}
                    </select>
                </div>

                <div id="cr-dub-status" style="font-size: 11px; color: #888; margin-bottom: 10px; height: 28px; overflow: hidden; text-overflow: ellipsis; line-height: 1.4;">
                    ${hasToken ? "Ready. Click 'Start Scan' to search." : "Please refresh page to capture token."}
                </div>

                <div style="background: #23252b; border-radius: 6px; padding: 10px; margin-bottom: 12px; text-align: center;">
                    <div style="color: #aaa; font-size: 10px; font-weight: bold; text-transform: uppercase;">Matching Anime Found</div>
                    <div id="cr-dub-matches-count" style="font-size: 24px; font-weight: bold; color: #4caf50; margin-top: 2px;">
                        ${matchedResults.length}
                    </div>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <button id="cr-dub-toggle-btn" style="flex: 1; padding: 9px; background: #ff640a; color: #fff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer;">
                        Start Scan
                    </button>
                </div>

                <div style="display: flex; gap: 8px;">
                    <button id="cr-dub-export-btn" style="flex: 1; padding: 6px; background: #2a2c34; border: 1px solid #444; color: #fff; border-radius: 6px; cursor: pointer; font-size: 11px;">
                        Download CSV (${matchedResults.length})
                    </button>
                    <button id="cr-dub-clear-btn" style="padding: 6px 10px; background: #2a2c34; border: 1px solid #444; color: #f44336; border-radius: 6px; cursor: pointer; font-size: 11px;">
                        Reset
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        document.getElementById('cr-dub-dropdown').onchange = (e) => {
            selectedDubId = e.target.value;
            chrome.storage.local.set({ selected_dub: selectedDubId });
            const chosen = DUBS.find((l) => l.id === selectedDubId);
            updateStatusText(`Target set to: ${chosen.label}`);
        };

        const minBtn = document.getElementById('cr-dub-min-btn');
        const bodyEl = document.getElementById('cr-dub-body');
        minBtn.onclick = () => {
            isMinimized = !isMinimized;
            bodyEl.style.display = isMinimized ? 'none' : 'block';
            minBtn.textContent = isMinimized ? '＋' : '—';
            panel.style.width = isMinimized ? '220px' : '330px';
        };

        document.getElementById('cr-dub-toggle-btn').onclick = () => {
            if (isScanning) {
                stopScan();
            } else {
                startScan();
            }
        };

        document.getElementById('cr-dub-export-btn').onclick = exportCSV;

        document.getElementById('cr-dub-clear-btn').onclick = () => {
            if (confirm("Clear all currently saved matching anime?")) {
                matchedResults = [];
                chrome.storage.local.set({ matched_results: [] });
                updateCountDisplay();
            }
        };
    }

    function checkAndInit() {
        createUI();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkAndInit);
    } else {
        checkAndInit();
    }

    window.addEventListener('popstate', checkAndInit);
    let lastUrl = window.location.href;
    setInterval(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            checkAndInit();
        }
    }, 500);

})();

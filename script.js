// ==UserScript==
// @name         Crunchyroll Dub Finder (Background API)
// @namespace    https://github.com/aramrw/cr_dub_finder
// @version      3.5
// @description  Scans Crunchyroll catalog using the internal /seasons and /episodes API, filters by chosen dub, and exports matching anime to a clean CSV.
// @match        https://www.crunchyroll.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // 0. DYNAMIC TOKEN INTERCEPTOR (document-start)
    // Passively captures the user's active Crunchyroll Bearer token without hardcoding.
    // ==========================================
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // Hook Fetch in real page context
    try {
        const origFetch = pageWindow.fetch;
        pageWindow.fetch = async function (...args) {
            try {
                const opts = args[1];
                if (opts && opts.headers) {
                    let auth = null;
                    if (opts.headers instanceof Headers) {
                        auth = opts.headers.get('Authorization') || opts.headers.get('authorization');
                    } else if (typeof opts.headers === 'object') {
                        auth = opts.headers['Authorization'] || opts.headers['authorization'];
                    }
                    if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
                        GM_setValue('cr_captured_token', auth);
                    }
                }
            } catch (e) {}
            return origFetch.apply(this, args);
        };
    } catch (e) {}

    // Hook XMLHttpRequest in real page context
    try {
        const origSetRequestHeader = pageWindow.XMLHttpRequest.prototype.setRequestHeader;
        pageWindow.XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
            if (header && header.toLowerCase() === 'authorization' && value && value.startsWith('Bearer ')) {
                GM_setValue('cr_captured_token', value);
            }
            return origSetRequestHeader.apply(this, arguments);
        };
    } catch (e) {}

    // ==========================================
    // 1. DUB DEFINITIONS
    // ==========================================
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

    // --- Storage Keys ---
    const KEY_RESULTS = 'cr_dub_matched_results';
    const KEY_SELECTED_DUB = 'cr_dub_selected';
    const KEY_MINIMIZED = 'cr_dub_minimized';

    let matchedResults = GM_getValue(KEY_RESULTS, []);
    let selectedDubId = GM_getValue(KEY_SELECTED_DUB, 'es-any');
    let isMinimized = GM_getValue(KEY_MINIMIZED, false);
    let isScanning = false;
    let shouldStop = false;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function getAuthToken() {
        return GM_getValue('cr_captured_token', null);
    }

    // ==========================================
    // 2. CRUNCHYROLL CMS API FETCHER (/seasons -> /seasons/{id}/episodes)
    // Crunchyroll routes episodes under seasons, not series.
    // episode.versions[].audio_locale reflects real in-player dubs.
    // ==========================================
    async function fetchSeriesDubLocales(seriesId) {
        const token = getAuthToken();
        const headers = {
            'Accept': 'application/json, text/plain, */*'
        };
        if (token) {
            headers['Authorization'] = token;
        }

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
    // 3. CATALOG SCANNER
    // ==========================================
    async function startScan() {
        if (isScanning) return;

        const token = getAuthToken();
        if (!token) {
            alert("⚠️ Your Crunchyroll session token hasn't been captured yet.\nPlease refresh the page once so the script can read your session token!");
            return;
        }

        // Collect all series links from the popular / browse page
        const cardAnchors = document.querySelectorAll('.browse-card a[href*="/series/"], [class*="browse-card"] a[href*="/series/"], a[href*="/series/"]');
        if (!cardAnchors || cardAnchors.length === 0) {
            alert("No anime cards found! Make sure you are on https://www.crunchyroll.com/videos/popular");
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
            alert("Could not extract series IDs from page links.");
            return;
        }

        isScanning = true;
        shouldStop = false;
        updateUIState(true);

        let matchesFoundThisSession = 0;
        const total = queue.length;
        console.log(`[CR Dub Finder] Starting scan of ${total} series for: ${currentDubObj.label}`);

        for (let i = 0; i < total; i++) {
            if (shouldStop) {
                console.log("[CR Dub Finder] Scan stopped by user.");
                break;
            }

            const item = queue[i];
            updateStatusText(`[${i + 1}/${total}] Checking: ${item.name}...`);

            try {
                const locales = await fetchSeriesDubLocales(item.seriesId);
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

            // Gentle delay between API requests (~600ms)
            await sleep(600);
        }

        isScanning = false;
        updateUIState(false);
        updateStatusText(shouldStop ? 'Scan paused.' : `🎉 Done! Found ${matchesFoundThisSession} matches out of ${total} shows.`);

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
        matchedResults = GM_getValue(KEY_RESULTS, []);
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
        GM_setValue(KEY_RESULTS, matchedResults);
        updateCountDisplay();
    }

    // ==========================================
    // 4. CLEAN CSV EXPORT (ONLY Matches: Name,Dubs,Series Link)
    // ==========================================
    function exportCSV() {
        const curMatches = GM_getValue(KEY_RESULTS, []);
        if (curMatches.length === 0) {
            alert("No matching anime found yet to export!");
            return;
        }

        const dubObj = DUBS.find((l) => l.id === selectedDubId) || DUBS[0];
        let csv = "Name,Dubs,Series Link\n";

        curMatches.forEach((row) => {
            const escape = (val) => `"${(val || '').replace(/"/g, '""')}"`;
            const name = escape(row.name);
            const dubs = escape(row.dubs || '');
            const url = escape(row.seriesUrl);

            csv += `${name},${dubs},${url}\n`;
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
    // 5. FLOATING UI WITH DUB DROPDOWN
    // ==========================================
    function updateStatusText(text) {
        const el = document.getElementById('cr-dub-status');
        if (el) el.textContent = text;
    }

    function updateCountDisplay() {
        const countEl = document.getElementById('cr-dub-matches-count');
        const exportBtn = document.getElementById('cr-dub-export-btn');
        const curMatches = GM_getValue(KEY_RESULTS, []);
        if (countEl) countEl.textContent = curMatches.length;
        if (exportBtn) exportBtn.textContent = `Download CSV (${curMatches.length})`;
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

    function createUI() {
        // Only display on /videos/popular
        if (!window.location.pathname.includes('/videos/popular')) {
            const existing = document.getElementById('cr-dub-widget');
            if (existing) existing.remove();
            return;
        }

        if (document.getElementById('cr-dub-widget')) return;

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
            box-shadow: 0 8px 24px rgba(0,0,0,0.8);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            width: ${isMinimized ? '220px' : '330px'};
            border: 2px solid #ff640a;
            user-select: none;
            transition: width 0.2s ease;
        `;

        const curMatches = GM_getValue(KEY_RESULTS, []);
        const hasToken = !!getAuthToken();

        const optionsHtml = DUBS.map((dub) =>
            `<option value="${dub.id}" ${dub.id === selectedDubId ? 'selected' : ''}>${dub.label}</option>`
        ).join('');

        panel.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center; gap: 8px;">
                    <span style="font-weight: bold; font-size: 14px; color: #ff640a;">CR Dub Finder</span>
                    <span id="cr-dub-badge" style="background: ${hasToken ? '#424242' : '#d32f2f'}; font-size: 10px; font-weight: bold; padding: 2px 6px; border-radius: 4px;">
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
                        ${curMatches.length}
                    </div>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <button id="cr-dub-toggle-btn" style="flex: 1; padding: 9px; background: #ff640a; color: #fff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer;">
                        Start Scan
                    </button>
                </div>

                <div style="display: flex; gap: 8px;">
                    <button id="cr-dub-export-btn" style="flex: 1; padding: 6px; background: #2a2c34; border: 1px solid #444; color: #fff; border-radius: 6px; cursor: pointer; font-size: 11px;">
                        Download CSV (${curMatches.length})
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
            GM_setValue(KEY_SELECTED_DUB, selectedDubId);
            const chosen = DUBS.find((l) => l.id === selectedDubId);
            updateStatusText(`Target set to: ${chosen.label}`);
        };

        const minBtn = document.getElementById('cr-dub-min-btn');
        const bodyEl = document.getElementById('cr-dub-body');
        minBtn.onclick = () => {
            isMinimized = !isMinimized;
            GM_setValue(KEY_MINIMIZED, isMinimized);
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
                GM_setValue(KEY_RESULTS, []);
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

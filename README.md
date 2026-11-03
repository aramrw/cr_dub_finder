<img width="631" height="334" alt="image" src="https://github.com/user-attachments/assets/4c7dcb69-e0f9-464f-ade1-24f911c36faa" />

# Crunchyroll Dub Finder

Scans anime on Crunchyroll to find shows with specific audio dubs and exports the matches to a CSV.

## Chrome Extension

### How it works
- Runs on `https://www.crunchyroll.com/videos/popular`.
- Captures your session token from network requests automatically.
- Queries Crunchyroll's API for episode audio versions.
- Filters shows by your selected dub.
- Exports matching anime to a CSV file.

### Installation
1. Clone or download this repo.
2. Open `chrome://extensions/` in your browser.
3. Turn on **Developer mode** in the top right.
4. Click **Load unpacked** and select this folder.
5. Open `https://www.crunchyroll.com/videos/popular` and click **Start Scan**.

## Tampermonkey Userscript

If you prefer Tampermonkey, copy `script.js` into a new userscript. It uses the same interface and logic.

## CSV Output

The CSV only includes anime that have your selected dub:

```csv
Name,Dubs,Series Link
frieren-beyond-journeys-end,"Japanese; English; French; Portuguese (Brazil); Spanish (Latin America); German; Spanish (Spain); Hindi; Tamil; Italian; Telugu; Polish; Arabic",https://www.crunchyroll.com/series/GG5H5XQX4/frieren-beyond-journeys-end
```

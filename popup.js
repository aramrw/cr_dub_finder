document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['cr_token'], (res) => {
        const badge = document.getElementById('token-badge');
        const desc = document.getElementById('token-desc');

        if (res.cr_token) {
            badge.textContent = 'ACTIVE';
            badge.style.background = '#2e7d32';
            desc.textContent = 'Captured automatically ✅';
            desc.style.color = '#4caf50';
        } else {
            badge.textContent = 'WAITING';
            badge.style.background = '#d32f2f';
            desc.textContent = 'Open Crunchyroll to capture';
            desc.style.color = '#ff9800';
        }
    });
});

const popups = {
    startingPopup: document.getElementById('startingPopup'),
    analysisPopup: document.getElementById('analysisPopup')
};

function showPopup(id) {
    if (popups[id]) popups[id].style.display = 'flex';
}

function closePopup(id) {
    if (popups[id]) popups[id].style.display = 'none';
}

function closeAllPopups() {
    Object.keys(popups).forEach(key => {
        popups[key].style.display = 'none';
    });
}

function switchAnalysisTab(tab) {
    const title = document.getElementById('analysisTitle');
    const content = document.getElementById('analysisContent');

    document.getElementById('btnReport')?.classList.remove('active');
    document.getElementById('btnSuggestions')?.classList.remove('active');

    if (tab === 'report') {
        document.getElementById('btnReport')?.classList.add('active');
        if (title) title.innerText = 'report summary will pop up here';
        if (content) content.innerText = 'report summary will pop up here';
    } else {
        document.getElementById('btnSuggestions')?.classList.add('active');
        if (title) title.innerText = 'suggestion summary will pop up here';
        if (content) content.innerText = 'suggestion summary will pop up here';
    }
}

window.showPopup = showPopup;
window.closePopup = closePopup;
window.closeAllPopups = closeAllPopups;
window.switchAnalysisTab = switchAnalysisTab;

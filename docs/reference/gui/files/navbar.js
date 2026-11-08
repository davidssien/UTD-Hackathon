const navItems = document.querySelectorAll('.nav-item');
const sliderTrack = document.getElementById('sliderTrack');

window.currentMode = 'Design';

navItems.forEach((item, index) => {
    item.addEventListener('click', () => {
        navItems.forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        sliderTrack.style.transform = `translateX(${index * 100}%)`;
        window.currentMode = item.getAttribute('data-mode');
        handleModeChange(window.currentMode);
    });
});

function handleModeChange(mode) {
    window.closeAllPopups();

    // Shut off active simulation threads if switching out of run scope
    if (mode !== 'Simulate' && typeof simulationActive !== 'undefined' && simulationActive) {
        if (typeof resetSimulation === 'function') {
            resetSimulation();
        }
    }

    // Force remove fire indicators when switching back to design mode layouts
    if (mode === 'Design') {
        if (typeof fires !== 'undefined') {
            fires = [];
        }
        if (typeof draw === 'function') {
            draw(false);
        }
    }

    if (mode === 'Analysis') {
        window.showPopup('analysisPopup');
        window.switchAnalysisTab('report');
    }

    if (typeof window.renderBottomBar === 'function') {
        window.renderBottomBar(mode);
    }
}

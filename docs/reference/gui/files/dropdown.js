const fileMenuBtn = document.getElementById('fileMenuBtn');
const fileDropdown = document.getElementById('fileDropdown');
const optNewFloor = document.getElementById('optNewFloor');
const optSaveFloor = document.getElementById('optSaveFloor');

fileMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileDropdown.style.display = fileDropdown.style.display === 'block' ? 'none' : 'block';
});

document.addEventListener('click', () => {
    fileDropdown.style.display = 'none';
});

optNewFloor.addEventListener('click', () => {
    // Automatically switch back to design mode
    window.currentMode = 'Design';

    // Clear all fire icons immediately
    if (typeof fires !== 'undefined') {
        fires = [];
    }

    // Update navigation bar slider state alignment
    const navItems = document.querySelectorAll('.nav-item');
    const sliderTrack = document.getElementById('sliderTrack');
    if (navItems.length && sliderTrack) {
        navItems.forEach(i => i.classList.remove('active'));
        navItems[0].classList.add('active'); // Design is index 0
        sliderTrack.style.transform = `translateX(0%)`;
    }

    // Trigger baseline layout handlers
    if (typeof handleModeChange === 'function') {
        handleModeChange('Design');
    }

    // Show the upload prompt workflow window overlay
    window.showPopup('startingPopup');

    if (typeof draw === 'function') {
        draw(false);
    }
});

optSaveFloor.addEventListener('click', () => {
    if (typeof draw === 'function') {
        let cachedFires = [...fires];
        fires = [];
        draw(true);

        let dataURL = canvas.toDataURL('image/png');
        let link = document.createElement('a');
        link.download = 'floorplan.png';
        link.href = dataURL;
        link.click();

        fires = cachedFires;
        draw(false);
    }
});

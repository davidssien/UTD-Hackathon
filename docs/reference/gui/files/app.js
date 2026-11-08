document.addEventListener('DOMContentLoaded', () => {
    console.log("2D Floor Plan Simulation Studio UI Engine successfully loaded.");

    window.currentMode = 'Design';

    if (typeof window.renderBottomBar === 'function') {
        window.renderBottomBar('Design');
    }

    window.addEventListener('beforeunload', () => {
        if (typeof resetSimulation === 'function') {
            resetSimulation();
        }
    });
});

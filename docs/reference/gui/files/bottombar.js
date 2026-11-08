const bottomBar = document.getElementById('bottomBar');

function renderBottomBar(mode) {
    bottomBar.innerHTML = '';

    if (mode === 'Design') {
        bottomBar.innerHTML = `
            <div class="tool-btn ${currentTool === 'pencil' ? 'active' : ''}" onclick="setTool('pencil')">✏️ Draw Line</div>
            <div class="tool-btn ${currentTool === 'box' ? 'active' : ''}" onclick="setTool('box')">🔲 Draw Room</div>
            <div class="tool-btn ${currentTool === 'eraser' ? 'active' : ''}" onclick="setTool('eraser')">🧼 Eraser</div>
            <div class="tool-btn clear-btn" style="background:#FFCDD2; border-color:#E57373;" onclick="clearAllLines()">🗑️ Clear Canvas</div>
        `;
    } else if (mode === 'Simulate') {
        if (!simulationActive) {
            bottomBar.innerHTML = `
                <div class="tool-btn" onclick="setSimAction('fire')">🔥 Place Fire</div>
                <div class="tool-btn run-btn" style="background:#81C784;" onclick="startSimulation()">▶️ Run</div>
            `;
        } else {
            bottomBar.innerHTML = `
                <div class="tool-btn disabled" style="opacity:0.4; cursor:not-allowed;">🔥 Place Fire</div>
                <div class="tool-btn restart-btn" style="background:#E57373; color:white;" onclick="resetSimulation()">🔄 Restart</div>
            `;
        }
    } else if (mode === 'Analysis') {
        bottomBar.innerHTML = `
            <div class="tool-btn active" id="btnReport" onclick="switchAnalysisTab('report')">📊 Report</div>
            <div class="tool-btn" id="btnSuggestions" onclick="switchAnalysisTab('suggestions')">💡 Suggestions</div>
        `;
    }
}

function setTool(tool) {
    currentTool = tool;
    panModeActive = false;
    document.getElementById('panBtn').classList.remove('active');
    renderBottomBar('Design');
}

function setSimAction(action) {
    if (simulationActive) return;
    console.log("Sim tool state configuration: " + action);
}

function startSimulation() {
    simulationActive = true;
    initAgents();
    simulationLoop();
    renderBottomBar('Simulate');
}

function resetSimulation() {
    simulationActive = false;
    agents = [];
    draw();
    renderBottomBar('Simulate');
}

// Action tool function to clean up workspace segments arrays cleanly
function clearAllLines() {
    if (confirm("Are you sure you want to delete all existing lines on your floor plan?")) {
        if (typeof lines !== 'undefined') {
            lines = [];
        }
        if (typeof draw === 'function') {
            draw(false);
        }
    }
}

window.renderBottomBar = renderBottomBar;

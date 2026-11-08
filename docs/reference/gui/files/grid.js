const canvas = document.getElementById('floorPlanCanvas');
const ctx = canvas.getContext('2d');

let panX = 0;
let panY = 0;
let isPanning = false;
let isDrawing = false;
let startX = 0;
let startY = 0;
let currentX = 0;
let currentY = 0;

let currentTool = 'pencil';
let panModeActive = false;

let lines = [];
let fires = [];
let simulationActive = false;
let agents = [];

const GRID_SIZE = 40;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    draw();
}
window.addEventListener('resize', resizeCanvas);

function snapToGrid(coord) {
    return Math.round(coord / GRID_SIZE) * GRID_SIZE;
}

function initAgents() {
    agents = [];

    // Fallback default coordinates if user hasn't generated structural layout bounds
    let defaultMinX = 200, defaultMaxX = 500, defaultMinY = 200, defaultMaxY = 500;

    if (lines.length > 0) {
        defaultMinX = Math.min(...lines.map(l => Math.min(l.x1, l.x2))) + 15;
        defaultMaxX = Math.max(...lines.map(l => Math.max(l.x1, l.x2))) - 15;
        defaultMinY = Math.min(...lines.map(l => Math.min(l.y1, l.y2))) + 15;
        defaultMaxY = Math.max(...lines.map(l => Math.max(l.y1, l.y2))) - 15;

        if (defaultMaxX <= defaultMinX) { defaultMinX -= 40; defaultMaxX += 40; }
        if (defaultMaxY <= defaultMinY) { defaultMinY -= 40; defaultMaxY += 40; }
    }

    for (let i = 0; i < 8; i++) {
        let spawnX = defaultMinX + Math.random() * (defaultMaxX - defaultMinX);
        let spawnY = defaultMinY + Math.random() * (defaultMaxY - defaultMinY);

        agents.push({
            x: spawnX,
            y: spawnY,
            vx: (Math.random() - 0.5) * 4,
            vy: (Math.random() - 0.5) * 4,
            radius: 6,
            color: `hsl(${Math.random() * 360}, 80%, 50%)`,
            history: [{ x: spawnX, y: spawnY }] // Keeps trace coordinates cached safely
        });
    }
}

function getDistanceToSegment(p, l) {
    let A = p.x - l.x1;
    let B = p.y - l.y1;
    let C = l.x2 - l.x1;
    let D = l.y2 - l.y1;
    let dot = A * C + B * D;
    let len_sq = C * C + D * D;
    let param = -1;
    if (len_sq != 0) param = dot / len_sq;
    let xx, yy;
    if (param < 0) { xx = l.x1; yy = l.y1; }
    else if (param > 1) { xx = l.x2; yy = l.y2; }
    else { xx = l.x1 + param * C; yy = l.y1 + param * D; }
    let dx = p.x - xx;
    let dy = p.y - yy;
    return { dist: Math.sqrt(dx * dx + dy * dy), nx: dx, ny: dy };
}

function simulationLoop() {
    if (!simulationActive) return;

    agents.forEach(agent => {
        agent.x += agent.vx;
        agent.y += agent.vy;

        // Push new trace frame point periodically
        if (Math.random() > 0.3) {
            agent.history.push({ x: agent.x, y: agent.y });
            if (agent.history.length > 25) agent.history.shift();
        }

        lines.forEach(line => {
            let res = getDistanceToSegment(agent, line);
            if (res.dist < agent.radius + 2) {
                let mag = Math.sqrt(res.nx * res.nx + res.ny * res.ny);
                if (mag > 0) { res.nx /= mag; res.ny /= mag; }
                let dotProd = agent.vx * res.nx + agent.vy * res.ny;
                agent.vx = agent.vx - 2 * dotProd * res.nx;
                agent.vy = agent.vy - 2 * dotProd * res.ny;
                agent.x += res.nx * 2;
                agent.y += res.ny * 2;
            }
        });

        if (agent.x < 0 || agent.x > canvas.width) agent.vx *= -1;
        if (agent.y < 0 || agent.y > canvas.height) agent.vy *= -1;
    });

    draw();
    requestAnimationFrame(simulationLoop);
}

function draw(isExport = false) {
    ctx.save();
    if (isExport) {
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    ctx.translate(panX, panY);

    ctx.strokeStyle = '#E0E0E0';
    ctx.lineWidth = 1;
    let startGridX = -panX - (-panX % GRID_SIZE) - GRID_SIZE;
    let startGridY = -panY - (-panY % GRID_SIZE) - GRID_SIZE;

    for (let x = startGridX; x < startGridX + canvas.width + GRID_SIZE * 2; x += GRID_SIZE) {
        ctx.beginPath(); ctx.moveTo(x, -panY - GRID_SIZE); ctx.lineTo(x, -panY + canvas.height + GRID_SIZE); ctx.stroke();
    }
    for (let y = startGridY; y < startGridY + canvas.height + GRID_SIZE * 2; y += GRID_SIZE) {
        ctx.beginPath(); ctx.moveTo(-panX - GRID_SIZE, y); ctx.lineTo(-panX + canvas.width + GRID_SIZE, y); ctx.stroke();
    }

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    lines.forEach(line => {
        ctx.beginPath(); ctx.moveTo(line.x1, line.y1); ctx.lineTo(line.x2, line.y2); ctx.stroke();
    });

    // Preview vector paths drawing layers
    if (isDrawing && !isPanning && window.currentMode === 'Design') {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.lineWidth = 3;
        let snapSX = snapToGrid(startX);
        let snapSY = snapToGrid(startY);
        let snapCX = snapToGrid(currentX);
        let snapCY = snapToGrid(currentY);

        if (currentTool === 'pencil') {
            // Force strict cardinal linear bounds (Locking drawing angles axis)
            if (Math.abs(currentX - startX) > Math.abs(currentY - startY)) {
                snapCY = snapSY;
            } else {
                snapCX = snapSX;
            }
            ctx.beginPath(); ctx.moveTo(snapSX, snapSY); ctx.lineTo(snapCX, snapCY); ctx.stroke();
        } else if (currentTool === 'box') {
            ctx.strokeRect(snapSX, snapSY, snapCX - snapSX, snapCY - snapSY);
        }
    }

    // Render historical trail path indicators behind active agents
    if (simulationActive) {
        agents.forEach(agent => {
            if (agent.history.length > 1) {
                ctx.beginPath();
                ctx.strokeStyle = agent.color;
                ctx.lineWidth = 2;
                ctx.globalAlpha = 0.3;
                ctx.moveTo(agent.history[0].x, agent.history[0].y);
                for (let h = 1; h < agent.history.length; h++) {
                    ctx.lineTo(agent.history[h].x, agent.history[h].y);
                }
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            }
        });

        agents.forEach(agent => {
            ctx.fillStyle = agent.color;
            ctx.beginPath(); ctx.arc(agent.x, agent.y, agent.radius, 0, Math.PI * 2); ctx.fill();
        });
    }

    // Render operational fire symbols using emoji text outputs
    ctx.font = `${GRID_SIZE * 0.7}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fires.forEach(fire => {
        ctx.fillText('🔥', fire.gridX * GRID_SIZE + GRID_SIZE / 2, fire.gridY * GRID_SIZE + GRID_SIZE / 2);
    });

    ctx.restore();
}

canvas.addEventListener('mousedown', (e) => {
    let mouseX = e.clientX - panX;
    let mouseY = e.clientY - panY;

    if (panModeActive || e.button === 1) {
        isPanning = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        return;
    }

    if (window.currentMode === 'Design') {
        isDrawing = true;
        startX = mouseX;
        startY = mouseY;
        currentX = mouseX;
        currentY = mouseY;

        if (currentTool === 'eraser') eraseAt(mouseX, mouseY);
    } else if (window.currentMode === 'Simulate') {
        if (simulationActive) return;
        let gridX = Math.floor(mouseX / GRID_SIZE);
        let gridY = Math.floor(mouseY / GRID_SIZE);
        toggleFire(gridX, gridY);
    }
});

canvas.addEventListener('mousemove', (e) => {
    let mouseX = e.clientX - panX;
    let mouseY = e.clientY - panY;

    if (isPanning) {
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        draw();
        return;
    }

    if (!isDrawing || window.currentMode !== 'Design') return;

    currentX = mouseX;
    currentY = mouseY;

    if (currentTool === 'eraser') {
        eraseAt(mouseX, mouseY);
    }
    draw();
});

canvas.addEventListener('mouseup', (e) => {
    if (isDrawing && window.currentMode === 'Design') {
        let mouseX = e.clientX - panX;
        let mouseY = e.clientY - panY;

        let snapSX = snapToGrid(startX);
        let snapSY = snapToGrid(startY);
        let snapCX = snapToGrid(mouseX);
        let snapCY = snapToGrid(mouseY);

        if (currentTool === 'pencil') {
            // Apply structural non-diagonal snapping logic down onto output model links
            if (Math.abs(mouseX - startX) > Math.abs(mouseY - startY)) {
                snapCY = snapSY;
            } else {
                snapCX = snapSX;
            }
            if (snapSX !== snapCX || snapSY !== snapCY) {
                lines.push({ x1: snapSX, y1: snapSY, x2: snapCX, y2: snapCY });
            }
        } else if (currentTool === 'box' && (snapSX !== snapCX || snapSY !== snapCY)) {
            lines.push({ x1: snapSX, y1: snapSY, x2: snapCX, y2: snapSY });
            lines.push({ x1: snapCX, y1: snapSY, x2: snapCX, y2: snapCY });
            lines.push({ x1: snapCX, y1: snapCY, x2: snapSX, y2: snapCY });
            lines.push({ x1: snapSX, y1: snapCY, x2: snapSX, y2: snapSY });
        }
    }
    isPanning = false;
    isDrawing = false;
    draw();
});

function eraseAt(x, y) {
    lines = lines.filter(line => getDistanceToSegment({ x: x, y: y }, line).dist > 15);
}

function toggleFire(gx, gy) {
    let index = fires.findIndex(f => f.gridX === gx && f.gridY === gy);
    if (index > -1) fires.splice(index, 1);
    else fires.push({ gridX: gx, gridY: gy });
    draw();
}

resizeCanvas();

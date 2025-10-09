'use strict';

// ============================ Utility Functions ============================
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}

// ============================ Global Variables & Constants ============================
let gl, mainProgram, skyProgram;
let mainProgramInfo, skyProgramInfo;
let trackBuffers, playerBuffers, cubeBuffers, skyBuffers;
const projectionMatrix = mat4.create();
const viewMatrix = mat4.create();

const game = {
    state: 'menu',
    level: null,
    currentLevelIndex: 0,
    lives: 3,
    time: 0,
    lastCheckpointZ: 0,
    lastTime: 0,
    accumulator: 0,
    fps: 60,
    debug: {
        showColliders: false,
        wireframe: false,
        panel: false,
    },
    settings: {
        dpr: Math.min(window.devicePixelRatio, 1.5),
    },
};

const player = {
    pos: vec3.create(),
    vel: vec3.create(),
    size: vec3.fromValues(0.8, 1.0, 1.5),
    onGround: false,
    coyoteTimeLeft: 0,
    jumpReleased: true,
    fuel: 100,
    oxygen: 100,
    speed: 0,
    speedTarget: 80.0,
    baseSpeed: 80.0,
    boostTimer: 0,
};

const camera = {
    pos: vec3.create(),
    target: vec3.create(),
    distance: 12.0,
    height: 5.0,
    lookAhead: 5.0,
    smoothSpeed: 4.0,
};

const input = {
    keys: new Set(),
    gamepad: null,
};

const PHYSICS_TICK_RATE = 1 / 60;
const MAX_UPDATES_PER_FRAME = 5;
const GRAVITY = -25.0;
const JUMP_IMPULSE = 12.0;
const COYOTE_TIME = 0.08;

const temp = {
    mat4: mat4.create(),
    mat4_2: mat4.create(),
    vec3: vec3.create(),
    vec3_2: vec3.create(),
    quat: quat.create(),
};
const UP_VECTOR = vec3.fromValues(0, 1, 0);

// ============================ Shader Sources ============================
const vsSource = `
    attribute vec4 aVertexPosition;
    attribute vec3 aVertexNormal;
    attribute float aMaterialId;

    uniform mat4 uProjectionMatrix;
    uniform mat4 uViewMatrix;
    uniform mat4 uModelMatrix;
    uniform mat3 uNormalMatrix;
    
    varying highp vec3 vWorldPosition;
    varying highp vec3 vNormal;
    varying highp float vMaterialId;

    void main(void) {
        vec4 worldPos = uModelMatrix * aVertexPosition;
        gl_Position = uProjectionMatrix * uViewMatrix * worldPos;
        vWorldPosition = worldPos.xyz;
        
        vNormal = normalize(uNormalMatrix * aVertexNormal);
        vMaterialId = aMaterialId;
    }
`;

const fsSource = `
    precision highp float;

    varying highp vec3 vWorldPosition;
    varying highp vec3 vNormal;
    varying highp float vMaterialId;
    
    uniform vec3 uCameraPosition;

    const vec3 FOG_COLOR = vec3(0.01, 0.015, 0.025);
    const float FOG_DENSITY = 0.003;

    void main(void) {
        vec3 materialColor;
        if (vMaterialId < 0.5) { materialColor = vec3(0.6, 0.65, 0.7); }       // Normal
        else if (vMaterialId < 1.5) { materialColor = vec3(0.9, 0.2, 0.2); }   // Hazard
        else if (vMaterialId < 2.5) { materialColor = vec3(0.2, 0.9, 0.2); }   // Boost
        else if (vMaterialId < 3.5) { materialColor = vec3(0.7, 0.9, 1.0); }   // Ice
        else if (vMaterialId < 4.5) { materialColor = vec3(0.9, 0.7, 0.1); }   // Fuel
        else if (vMaterialId < 5.5) { materialColor = vec3(0.1, 0.7, 0.9); }   // Oxygen
        else if (vMaterialId < 6.5) { materialColor = vec3(0.8, 0.2, 0.8); }   // Finish
        else { materialColor = vec3(0.9, 0.9, 0.9); }                         // Player
        
        vec3 finalColor = materialColor; // No lighting calculation for flat shading

        // Player ship fresnel effect
        if (vMaterialId > 6.5) {
             vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
             float fresnel = pow(1.0 - max(dot(viewDir, normalize(vNormal)), 0.0), 3.0);
             finalColor += vec3(0.5, 0.8, 1.0) * fresnel * 0.5;
        }

        // Fog
        float dist = length(uCameraPosition - vWorldPosition);
        float fogFactor = exp(-dist * dist * FOG_DENSITY * FOG_DENSITY);
        fogFactor = clamp(fogFactor, 0.0, 1.0);

        // Vignette (assuming 1280x720 aspect ratio, adjust if needed)
        vec2 screenPos = gl_FragCoord.xy / vec2(1280.0, 720.0);
        float vignette = 1.0 - smoothstep(0.4, 1.0, length(screenPos - 0.5));
        
        gl_FragColor = vec4(mix(FOG_COLOR, finalColor, fogFactor) - vignette * 0.2, 1.0);
    }
`;

const skyVsSource = `
    attribute vec4 aVertexPosition;
    varying highp vec3 vWorldPosition;
    uniform mat4 uProjectionMatrix;
    uniform mat4 uViewMatrix;
    
    void main() {
        mat4 viewRotationOnly = mat4(mat3(uViewMatrix)); 
        gl_Position = uProjectionMatrix * viewRotationOnly * aVertexPosition;
        vWorldPosition = aVertexPosition.xyz;
    }
`;
const skyFsSource = `
    precision highp float;
    varying highp vec3 vWorldPosition;

    const vec3 TOP_COLOR = vec3(0.2, 0.4, 0.8);
    const vec3 HORIZON_COLOR = vec3(0.8, 0.6, 0.5);
    const vec3 BOTTOM_COLOR = vec3(0.01, 0.015, 0.025);

    void main() {
        float h = normalize(vWorldPosition).y;
        vec3 finalColor = (h > 0.0) ? mix(HORIZON_COLOR, TOP_COLOR, h) : mix(HORIZON_COLOR, BOTTOM_COLOR, -h);
        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

// ============================ WebGL Initialization & Utilities ============================
function initShaderProgram(gl, vsSource, fsSource) {
    const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
    const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vertexShader || !fragmentShader) {
        return null;
    }
    const shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);
    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
        alert('Unable to initialize the shader program: ' + gl.getProgramInfoLog(shaderProgram));
        return null;
    }
    return shaderProgram;
}

function loadShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createVbo(data) {
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data.vertices), gl.STATIC_DRAW);

    const normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data.normals), gl.STATIC_DRAW);
    
    const materialIdBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, materialIdBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data.materialIds), gl.STATIC_DRAW);

    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(data.indices), gl.STATIC_DRAW);

    return {
        position: posBuffer,
        normal: normalBuffer,
        materialId: materialIdBuffer,
        indices: indexBuffer,
        vertexCount: data.indices.length
    };
}

function resizeCanvasToDisplaySize(canvas) {
    const displayWidth = Math.floor(canvas.clientWidth * game.settings.dpr);
    const displayHeight = Math.floor(canvas.clientHeight * game.settings.dpr);
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        return true;
    }
    return false;
}

// ============================ Level Data ============================
const MATERIALS = {
    NORMAL: { id: 0 }, HAZARD: { id: 1 }, BOOST:  { id: 2 }, ICE: { id: 3 },
    FUEL:   { id: 4 }, OXY:    { id: 5 }, FINISH: { id: 6 }, PLAYER: { id: 7 },
};
const levels = [
    {
        id: 'level1', name: "Level 1 - The Basics",
        playerStart: { pos: [0, 2, 10] }, finishZ: 1000,
        oxygenStart: 100, fuelStart: 100,
        oxygenDrainPerSec: 2, fuelDrainPerSec: 4,
        segments: [
            { type: "straight", length: 100, width: 10, material: "NORMAL" },
            { type: "gap", length: 15 },
            { type: "straight", length: 50, material: "BOOST" },
            { type: "straight", length: 150, material: "NORMAL" },
            { type: "ramp", length: 30, pitch: 0.2, material: "NORMAL" },
            { type: "gap", length: 50 },
            { type: "platform", length: 40, width: 20, material: "FUEL" },
            { type: "gap", length: 20 },
            { type: "straight", length: 100, width: 6, material: "ICE" },
            { type: "curve", length: 100, yaw: 0.3, material: "NORMAL" },
            { type: "straight", length: 50, material: "HAZARD" },
            { type: "gap", length: 10 },
            { type: "platform", length: 20, width: 20, material: "OXY" },
            { type: "straight", length: 250, width: 10, material: "NORMAL" },
            { type: "straight", length: 20, width: 10, material: "FINISH" },
        ]
    },
    {
        id: 'level2', name: "Level 2 - The Gauntlet",
        playerStart: { pos: [0, 2, 10] }, finishZ: 1500,
        oxygenStart: 100, fuelStart: 100,
        oxygenDrainPerSec: 5, fuelDrainPerSec: 7,
        segments: [
            { type: "straight", length: 50, width: 8, material: "NORMAL" },
            { type: "gap", length: 20 },
            { type: "straight", length: 30, width: 4, material: "NORMAL" },
            { type: "gap", length: 20 },
            { type: "straight", length: 30, width: 4, material: "NORMAL" },
            { type: "curve", length: 150, yaw: -0.5, width: 6, material: "ICE" },
            { type: "ramp", length: 40, pitch: 0.3, material: "BOOST" },
            { type: "gap", length: 80 },
            { type: "platform", length: 20, width: 20, material: "FUEL" },
            { type: "straight", length: 200, width: 10, material: "HAZARD" },
            { type: "gap", length: 10 }, { type: "straight", length: 300, material: "NORMAL" },
            { type: "curve", length: 200, yaw: 0.8, material: "NORMAL" },
            { type: "gap", length: 10 }, { type: "platform", length: 20, width: 20, material: "OXY" },
            { type: "straight", length: 250, material: "NORMAL" },
            { type: "straight", length: 20, material: "FINISH" },
        ]
    }
];

// ============================ Build Track Geometry ============================
function generateEndlessLevel() {
    const segments = [{ type: "straight", length: 50, width: 10, material: "NORMAL" }];
    let segmentCount = 100;
    const rand = (min, max) => Math.random() * (max - min) + min;

    for (let i = 0; i < segmentCount; i++) {
        const r = Math.random();
        if (r < 0.4) {
            segments.push({ type: 'straight', length: rand(50, 200), width: rand(6, 12), material: 'NORMAL' });
        } else if (r < 0.6) {
            segments.push({ type: 'curve', length: rand(80, 150), yaw: rand(-0.4, 0.4), width: rand(8, 12), material: 'NORMAL' });
        } else if (r < 0.75) {
            segments.push({ type: 'ramp', length: rand(20, 40), pitch: rand(0.1, 0.3), material: 'BOOST' });
            segments.push({ type: 'gap', length: rand(30, 80) });
        } else {
            const matR = Math.random();
            let material = (matR < 0.25) ? 'ICE' : (matR < 0.5) ? 'HAZARD' : (matR < 0.75) ? 'FUEL' : 'OXY';
            segments.push({ type: 'platform', length: rand(20, 50), width: rand(15, 25), material });
            segments.push({ type: 'gap', length: rand(10, 25) });
        }
    }
    segments.push({ type: 'straight', length: 20, material: 'FINISH' });
    let totalZ = segments.reduce((acc, s) => acc + s.length, 0);
    return {
        id: 'endless', name: "Endless Mode", playerStart: { pos: [0, 2, 10] },
        finishZ: totalZ - 50, oxygenStart: 100, fuelStart: 100,
        oxygenDrainPerSec: 3, fuelDrainPerSec: 5, segments: segments,
    };
}
function buildTrack(level) {
    const vertices = [], indices = [], normals = [], materialIds = [];
    const segments = [];
    let currentIndex = 0;
    const currentPos = vec3.fromValues(0, 0, 0);
    const currentRot = quat.create();

    for (const segDef of level.segments) {
        if (segDef.type === 'gap') {
            currentPos[2] += segDef.length;
            continue;
        }
        const length = segDef.length, width = segDef.width || 10, height = segDef.height || 1.0;
        const material = MATERIALS[segDef.material] || MATERIALS.NORMAL;
        const modelMatrix = mat4.create();
        mat4.fromRotationTranslation(modelMatrix, currentRot, currentPos);
        
        // FIX: Use mat4.rotateX with the angle and axis, not a quaternion.
        if (segDef.pitch) {
            mat4.rotateX(modelMatrix, modelMatrix, segDef.pitch);
        }
        
        const worldAABB = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
        [[ -width/2, -height, 0], [width/2, 0, length]].forEach(cornerBase => {
            for(let i=0; i<8; i++){
                const c = [cornerBase[0] * (i&1?1:-1), cornerBase[1] * (i&2?1:-1), cornerBase[2] * (i&4?1:-1)];
                const wc = vec3.transformMat4(temp.vec3, c, modelMatrix);
                worldAABB.minX = Math.min(worldAABB.minX, wc[0]); worldAABB.maxX = Math.max(worldAABB.maxX, wc[0]);
                worldAABB.minY = Math.min(worldAABB.minY, wc[1]); worldAABB.maxY = Math.max(worldAABB.maxY, wc[1]);
                worldAABB.minZ = Math.min(worldAABB.minZ, wc[2]); worldAABB.maxZ = Math.max(worldAABB.maxZ, wc[2]);
            }
        });
        
        segments.push({ ...segDef, modelMatrix, material, aabb: worldAABB });

        const tileCount = Math.max(1, Math.round(length / width));
        for (let i = 0; i < tileCount; i++) {
            const z = (i / tileCount) * length, tileLength = length / tileCount;
            const tileVerts = [ -width/2,0,z, width/2,0,z, width/2,0,z+tileLength, -width/2,0,z+tileLength ];
            for(let j=0; j<tileVerts.length; j+=3){
                const lp = vec3.fromValues(tileVerts[j], tileVerts[j+1], tileVerts[j+2]);
                vec3.transformMat4(lp, lp, modelMatrix);
                vertices.push(lp[0], lp[1], lp[2]);
                materialIds.push(material.id);
                const ln = vec3.fromValues(0,1,0);
                const normalMatrix3 = mat3.create();
                mat3.fromMat4(normalMatrix3, modelMatrix);
                mat3.invert(normalMatrix3, normalMatrix3);
                mat3.transpose(normalMatrix3, normalMatrix3);
                vec3.transformMat3(ln, ln, normalMatrix3); 
                vec3.normalize(ln, ln);
                normals.push(ln[0], ln[1], ln[2]);
            }
            [0,1,2,0,2,3].forEach(idx => indices.push(currentIndex + idx));
            currentIndex += 4;
        }
        const forward = vec3.fromValues(0, 0, length);
        if (segDef.pitch) vec3.transformQuat(forward, forward, quat.setAxisAngle(temp.quat, [1, 0, 0], segDef.pitch));
        vec3.transformQuat(forward, forward, currentRot);
        vec3.add(currentPos, currentPos, forward);
        if (segDef.yaw) quat.multiply(currentRot, currentRot, quat.setAxisAngle(temp.quat, [0, 1, 0], segDef.yaw));
    }
    return { vertices, indices, normals, materialIds, segments };
}
function createPlayerBuffers() {
    const s=0.5, l=1.0;
    const vertices = [ 0,s,l, -s*1.2,-s,-l, s*1.2,-s,-l, 0,s,-l, -s*0.8,-s,-l, s*0.8,-s,-l ];
    const indices = [ 0,1,2, 3,4,5, 0,3,1, 3,4,1, 0,2,5, 3,0,5, 1,4,5, 1,5,2 ];
    const normals = [], materialIds = [];
    for (let i=0; i<vertices.length/3; i++) { normals.push(0,1,0); materialIds.push(MATERIALS.PLAYER.id); }
    return createVbo({ vertices, indices, normals, materialIds });
}
function createCubeBuffers(size = 1.0) {
    const s = size/2;
    const v = [ -s,-s,s, s,-s,s, s,s,s, -s,s,s, -s,-s,-s, -s,s,-s, s,s,-s, s,-s,-s, ];
    const i = [ 0,1,2,0,2,3, 4,5,6,4,6,7, 3,2,6,3,6,5, 4,7,1,4,1,0, 1,7,6,1,6,2, 4,0,3,4,3,5, ];
    const wi = [ 0,1,1,2,2,3,3,0, 4,5,5,6,6,7,7,4, 0,4,1,7,2,6,3,5 ];
    const n = [], m = []; for(let i=0;i<v.length/3;i++){n.push(0,1,0);m.push(0);}
    const buffers = createVbo({ vertices: v, indices: i, normals: n, materialIds: m });
    
    const wireframeIndexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireframeIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(wi), gl.STATIC_DRAW);
    buffers.wireframeIndices = wireframeIndexBuffer;
    buffers.wireframeVertexCount = wi.length;

    return buffers;
}

// ============================ Physics & Collision ============================
function updatePhysics(dt) {
    if (game.state !== 'playing') return;
    pollGamepad();
    let accel=0, strafe=0;
    if (input.keys.has('KeyW')||input.keys.has('ArrowUp')) accel=1.0;
    if (input.keys.has('KeyS')||input.keys.has('ArrowDown')) accel=-1.0;
    if (input.keys.has('KeyA')||input.keys.has('ArrowLeft')) strafe=-1.0;
    if (input.keys.has('KeyD')||input.keys.has('ArrowRight')) strafe=1.0;
    if (input.gamepad) {
        if(input.gamepad.buttons[7]?.pressed) accel=input.gamepad.buttons[7].value;
        if(input.gamepad.buttons[6]?.pressed) accel=-input.gamepad.buttons[6].value;
        const stickX = input.gamepad.axes[0];
        if (Math.abs(stickX) > 0.15) strafe=stickX;
    }
    const targetZVel = player.speedTarget * (accel > 0 ? 1 : 0.5);
    player.vel[2] = lerp(player.vel[2], (accel !== 0) ? targetZVel*Math.sign(accel) : player.vel[2]*0.98, (accel>0?100:200)*dt);
    player.vel[2] = clamp(player.vel[2], -player.baseSpeed*0.5, player.speedTarget*1.5);
    let strafeControl = player.onGround ? 25.0 : 10.0;
    if(input.keys.has('ShiftLeft')) strafeControl *= 0.5;
    player.vel[0] += strafe * strafeControl * dt;
    const jumpPressed = input.keys.has('Space') || input.gamepad?.buttons[0]?.pressed;
    if (jumpPressed && player.jumpReleased && (player.onGround || player.coyoteTimeLeft > 0)) {
        player.vel[1] = JUMP_IMPULSE; player.onGround = false; player.coyoteTimeLeft=0; player.jumpReleased=false;
    }
    if (!jumpPressed) player.jumpReleased = true;
    if (!player.onGround) { player.vel[1] += GRAVITY*dt; player.coyoteTimeLeft -= dt; } else { player.coyoteTimeLeft=COYOTE_TIME; }
    const friction = player.onGround?1.0:0.1;
    player.vel[0] *= (1-2.0*friction*dt); if(accel===0) player.vel[2] *= (1-0.5*friction*dt);
    vec3.scaleAndAdd(player.pos, player.pos, player.vel, dt);
    player.onGround=false; const playerBox=getPlayerAABB(); let currentSegment=null;
    const playerSegIdx=findSegmentIndexAt(player.pos[2]);
    for(let i=Math.max(0, playerSegIdx-5); i<Math.min(game.track.segments.length, playerSegIdx+5); i++){
        const seg=game.track.segments[i];
        if (playerBox.maxX>seg.aabb.minX && playerBox.minX<seg.aabb.maxX && playerBox.maxZ>seg.aabb.minZ && playerBox.minZ<seg.aabb.maxZ && playerBox.minY<seg.aabb.maxY && playerBox.maxY>seg.aabb.minY){
            const overlapY = seg.aabb.maxY-playerBox.minY;
            if (overlapY>0 && player.vel[1]<=0) { player.pos[1]+=overlapY; player.vel[1]=0; player.onGround=true; currentSegment=seg; break; }
        }
    }
    if(player.onGround&&currentSegment) handleMaterial(currentSegment.material);
    if(accel>0) player.fuel -= game.level.fuelDrainPerSec*dt*(player.vel[2]/player.baseSpeed);
    player.oxygen -= game.level.oxygenDrainPerSec * dt;
    if(player.boostTimer>0) { player.boostTimer-=dt; if(player.boostTimer<=0) player.speedTarget=player.baseSpeed; }
    player.speed=vec3.length(player.vel);
    if(player.pos[1]<-50||player.fuel<=0||player.oxygen<=0) handlePlayerDeath();
    if(player.pos[2]>game.level.finishZ) finishLevel();
    if(Math.floor(player.pos[2]/500)>Math.floor(game.lastCheckpointZ/500)) game.lastCheckpointZ=Math.floor(player.pos[2]/500)*500;
}
function handleMaterial(mat) {
    switch(mat.id) {
        case MATERIALS.HAZARD.id: handlePlayerDeath(); break;
        case MATERIALS.BOOST.id: player.speedTarget=player.baseSpeed*1.8; player.boostTimer=3.0; break;
        case MATERIALS.ICE.id: player.vel[0]*=(1-0.2*1.0*PHYSICS_TICK_RATE); break;
        case MATERIALS.FUEL.id: player.fuel=Math.min(100,player.fuel+50*PHYSICS_TICK_RATE); break;
        case MATERIALS.OXY.id: player.oxygen=Math.min(100,player.oxygen+50*PHYSICS_TICK_RATE); break;
    }
}
function getPlayerAABB() { return { minX:player.pos[0]-player.size[0]/2, maxX:player.pos[0]+player.size[0]/2, minY:player.pos[1]-player.size[1]/2, maxY:player.pos[1]+player.size[1]/2, minZ:player.pos[2]-player.size[2]/2, maxZ:player.pos[2]+player.size[2]/2, }; }
function findSegmentIndexAt(z) { for (let i=0; i<game.track.segments.length; i++) { if (z>=game.track.segments[i].aabb.minZ && z<=game.track.segments[i].aabb.maxZ) return i; } let c=0, d=Infinity; for (let i=0; i<game.track.segments.length; i++) { let dist = Math.abs(z-(game.track.segments[i].aabb.minZ+game.track.segments[i].aabb.maxZ)/2); if(dist<d){d=dist;c=i;}} return c; }
function updateCamera(dt) {
    const desiredPos=temp.vec3; vec3.scale(desiredPos, player.vel, 0.1); vec3.add(desiredPos, player.pos, desiredPos);
    desiredPos[1]+=camera.height; desiredPos[2]-=camera.distance;
    vec3.lerp(camera.pos, camera.pos, desiredPos, camera.smoothSpeed*dt);
    const targetPos=temp.vec3_2; vec3.copy(targetPos, player.pos); targetPos[1]+=1.0; targetPos[2]+=camera.lookAhead;
    mat4.lookAt(viewMatrix, camera.pos, targetPos, UP_VECTOR);
}

// ============================ Input Handling ============================
function initInput() {
    window.addEventListener('keydown', e => {
        input.keys.add(e.code);
        if (e.code==='KeyP') { if(game.state==='playing') pauseGame(); else if(game.state==='paused') resumeGame(); }
        if (e.code==='KeyR' && (game.state==='playing'||game.state==='dead')) handlePlayerDeath(true);
        if (e.code==='F3') { e.preventDefault(); game.debug.panel=!game.debug.panel; document.getElementById('debug-panel').style.display=game.debug.panel?'block':'none'; }
    });
    window.addEventListener('keyup', e => input.keys.delete(e.code));
    document.getElementById('debug-colliders').addEventListener('change', e => game.debug.showColliders=e.target.checked);
    document.getElementById('debug-wireframe').addEventListener('change', e => game.debug.wireframe=e.target.checked);
}
function pollGamepad() { if (!navigator.getGamepads) return; input.gamepad = navigator.getGamepads()[0]; }

// ============================ HUD & UI Management ============================
const hud = {}; const debugUI = {};
function setupUI() {
    Object.assign(hud, { levelName: document.getElementById('level-name'), speed: document.getElementById('speed-value'), distance: document.getElementById('distance-value'), lives: document.getElementById('lives-value'), time: document.getElementById('time-value'), fps: document.getElementById('fps-value'), fuelFill: document.getElementById('fuel-fill'), oxygenFill: document.getElementById('oxygen-fill'), mainMenu: document.getElementById('main-menu-overlay'), pauseMenu: document.getElementById('pause-overlay'), resultsMenu: document.getElementById('results-overlay') });
    Object.assign(debugUI, { pos: document.getElementById('debug-pos'), vel: document.getElementById('debug-vel'), ground: document.getElementById('debug-ground'), segment: document.getElementById('debug-segment'), segType: document.getElementById('debug-seg-type') });
    document.getElementById('start-level-1').addEventListener('click', () => startGame(0));
    document.getElementById('start-level-2').addEventListener('click', () => startGame(1));
    document.getElementById('start-endless').addEventListener('click', () => startGame('endless'));
    document.getElementById('resume-button').addEventListener('click', resumeGame);
    document.getElementById('restart-level-button').addEventListener('click', () => { game.lives=3; startGame(game.currentLevelIndex); });
    document.getElementById('quit-to-menu-button').addEventListener('click', quitToMenu);
    document.getElementById('next-level-button').addEventListener('click', () => startGame(game.currentLevelIndex + 1));
    document.getElementById('results-restart-button').addEventListener('click', () => startGame(game.currentLevelIndex));
    document.getElementById('results-quit-button').addEventListener('click', quitToMenu);
}
function updateHUD() {
    hud.speed.textContent=(player.speed*3.6).toFixed(0); hud.distance.textContent=player.pos[2].toFixed(0); hud.lives.textContent=game.lives; hud.time.textContent=game.time.toFixed(2); hud.fps.textContent=game.fps.toFixed(0);
    hud.fuelFill.style.width=clamp(player.fuel,0,100)+'%'; hud.fuelFill.classList.toggle('low',player.fuel<20);
    hud.oxygenFill.style.width=clamp(player.oxygen,0,100)+'%'; hud.oxygenFill.classList.toggle('low',player.oxygen<20);
    if (game.debug.panel) {
        debugUI.pos.textContent=`${player.pos[0].toFixed(1)}, ${player.pos[1].toFixed(1)}, ${player.pos[2].toFixed(1)}`;
        debugUI.vel.textContent=`${player.vel[0].toFixed(1)}, ${player.vel[1].toFixed(1)}, ${player.vel[2].toFixed(1)}`;
        debugUI.ground.textContent=player.onGround; const segIdx=findSegmentIndexAt(player.pos[2]); debugUI.segment.textContent=segIdx;
        if(game.track && game.track.segments[segIdx]) debugUI.segType.textContent=`${game.track.segments[segIdx].type} / ${game.track.segments[segIdx].material.id}`;
    }
}

// ============================ Game State Management ============================
function resetPlayer(toCheckpoint = false) {
    if(toCheckpoint && game.level) { vec3.set(player.pos, 0, 2, game.lastCheckpointZ); }
    else if (game.level) { vec3.copy(player.pos, game.level.playerStart.pos); game.lastCheckpointZ = game.level.playerStart.pos[2]; }
    vec3.set(player.vel,0,0,0); player.onGround=false; player.speedTarget=player.baseSpeed; player.boostTimer=0;
    if(!toCheckpoint){ player.fuel=game.level.fuelStart; player.oxygen=game.level.oxygenStart; }
}
function startGame(levelIndex) {
    game.level = (levelIndex==='endless') ? generateEndlessLevel() : (levelIndex>=levels.length) ? null : levels[levelIndex];
    if(!game.level){ quitToMenu(); return; }
    game.currentLevelIndex=levelIndex; game.track=buildTrack(game.level); trackBuffers=createVbo(game.track);
    resetPlayer(false); game.time=0; game.state='playing';
    hud.mainMenu.classList.remove('visible'); hud.pauseMenu.classList.remove('visible'); hud.resultsMenu.classList.remove('visible');
    hud.levelName.textContent=game.level.name;
}
function pauseGame() { if(game.state!=='playing')return; game.state='paused'; hud.pauseMenu.classList.add('visible'); }
function resumeGame() { if(game.state!=='paused')return; game.state='playing'; hud.pauseMenu.classList.remove('visible'); }
function quitToMenu() { game.state='menu'; hud.mainMenu.classList.add('visible'); hud.pauseMenu.classList.remove('visible'); hud.resultsMenu.classList.remove('visible'); }
function handlePlayerDeath(isManualReset = false) {
    if(game.state!=='playing' && !isManualReset) return;
    game.lives--;
    if(game.lives<0) { showResults("Game Over", false); game.lives=3; }
    else { game.state='dead'; setTimeout(()=>{resetPlayer(true); game.state='playing';}, 1000); }
}
function finishLevel() { if(game.state!=='playing')return; game.state='finished'; showResults("Level Complete!"); }
function showResults(title, showNext=true) {
    document.getElementById('results-title').textContent=title; document.getElementById('results-time').textContent=game.time.toFixed(2)+'s';
    const key=`best_time_${game.level.id}`; let best=parseFloat(localStorage.getItem(key)||'Infinity');
    if(game.time<best&&title.includes('Complete')) { best=game.time; localStorage.setItem(key,best.toFixed(2)); }
    document.getElementById('results-best-time').textContent=isFinite(best)?best.toFixed(2)+'s':'N/A';
    document.getElementById('next-level-button').style.display=showNext?'block':'none';
    hud.resultsMenu.classList.add('visible');
}

// ============================ Drawing Functions ============================
function drawScene() {
    resizeCanvasToDisplaySize(gl.canvas);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    mat4.perspective(projectionMatrix, 45*Math.PI/180, gl.canvas.clientWidth/gl.canvas.clientHeight, 0.1, 4000.0);
    drawSky();
    gl.useProgram(mainProgramInfo.program);
    gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.projectionMatrix, false, projectionMatrix);
    gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.viewMatrix, false, viewMatrix);
    gl.uniform3fv(mainProgramInfo.uniformLocations.cameraPosition, camera.pos);
    drawTrack();
    drawPlayer();
    if (game.debug.showColliders) drawColliders();
}
function drawTrack() {
    if (!trackBuffers) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, trackBuffers.position); gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, trackBuffers.normal); gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexNormal, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexNormal);
    gl.bindBuffer(gl.ARRAY_BUFFER, trackBuffers.materialId); gl.vertexAttribPointer(mainProgramInfo.attribLocations.materialId, 1, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(mainProgramInfo.attribLocations.materialId);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, trackBuffers.indices);
    mat4.identity(temp.mat4); 
    gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.modelMatrix, false, temp.mat4);

    const normalMatrix = mat3.create();
    mat3.identity(normalMatrix);
    gl.uniformMatrix3fv(mainProgramInfo.uniformLocations.normalMatrix, false, normalMatrix);

    gl.drawElements(game.debug.wireframe ? gl.LINES : gl.TRIANGLES, trackBuffers.vertexCount, gl.UNSIGNED_SHORT, 0);
}
function drawPlayer() {
    gl.bindBuffer(gl.ARRAY_BUFFER, playerBuffers.position); gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, playerBuffers.normal); gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexNormal, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexNormal);
    gl.bindBuffer(gl.ARRAY_BUFFER, playerBuffers.materialId); gl.vertexAttribPointer(mainProgramInfo.attribLocations.materialId, 1, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(mainProgramInfo.attribLocations.materialId);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, playerBuffers.indices);
    const modelMatrix=temp.mat4; mat4.fromTranslation(modelMatrix,player.pos); mat4.rotateZ(modelMatrix,modelMatrix,-player.vel[0]*0.05);
    gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.modelMatrix, false, modelMatrix);

    const normalMatrix = mat3.create();
    mat3.fromMat4(normalMatrix, modelMatrix);
    mat3.invert(normalMatrix, normalMatrix);
    mat3.transpose(normalMatrix, normalMatrix);
    gl.uniformMatrix3fv(mainProgramInfo.uniformLocations.normalMatrix, false, normalMatrix);

    gl.drawElements(gl.TRIANGLES, playerBuffers.vertexCount, gl.UNSIGNED_SHORT, 0);
}
function drawColliders() {
    if(!game.track) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffers.position); gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexPosition,3,gl.FLOAT,false,0,0); gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffers.normal); gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexNormal,3,gl.FLOAT,false,0,0); gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexNormal);
    gl.disableVertexAttribArray(mainProgramInfo.attribLocations.materialId); gl.vertexAttrib1f(mainProgramInfo.attribLocations.materialId, MATERIALS.PLAYER.id);
    
    game.track.segments.forEach(seg=>{
        if (seg.type === 'gap') return;
        const aabb=seg.aabb; const center=[(aabb.minX+aabb.maxX)/2, (aabb.minY+aabb.maxY)/2, (aabb.minZ+aabb.maxZ)/2]; const size=[aabb.maxX-aabb.minX, aabb.maxY-aabb.minY, aabb.maxZ-aabb.minZ];
        const modelMatrix=mat4.create(); mat4.fromTranslation(modelMatrix,center); mat4.scale(modelMatrix,modelMatrix,size);
        gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.modelMatrix,false,modelMatrix);

        const normalMatrix = mat3.create();
        mat3.fromMat4(normalMatrix, modelMatrix);
        mat3.invert(normalMatrix, normalMatrix);
        mat3.transpose(normalMatrix, normalMatrix);
        gl.uniformMatrix3fv(mainProgramInfo.uniformLocations.normalMatrix, false, normalMatrix);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cubeBuffers.wireframeIndices);
        gl.drawElements(gl.LINES, cubeBuffers.wireframeVertexCount, gl.UNSIGNED_SHORT, 0);
    });
}
function drawSky() {
    gl.useProgram(skyProgramInfo.program); gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffers.position); gl.vertexAttribPointer(skyProgramInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(skyProgramInfo.attribLocations.vertexPosition);
    gl.uniformMatrix4fv(skyProgramInfo.uniformLocations.projectionMatrix, false, projectionMatrix);
    gl.uniformMatrix4fv(skyProgramInfo.uniformLocations.viewMatrix, false, viewMatrix);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, skyBuffers.indices);
    gl.drawElements(gl.TRIANGLES, skyBuffers.vertexCount, gl.UNSIGNED_SHORT, 0);
    gl.depthMask(true);
}

// ============================ Main Render Loop ============================
function render(time) {
    time *= 0.001;
    const deltaTime = Math.min(time - game.lastTime, 0.1); // Clamp delta to avoid spiral of death
    game.lastTime = time;

    if (game.state === 'playing') game.time += deltaTime;

    game.fps = 0.95 * game.fps + 0.05 * (1 / deltaTime);
    
    game.accumulator += deltaTime;
    let updates = 0;
    while (game.accumulator >= PHYSICS_TICK_RATE && updates < MAX_UPDATES_PER_FRAME) {
        updatePhysics(PHYSICS_TICK_RATE);
        game.accumulator -= PHYSICS_TICK_RATE;
        updates++;
    }

    updateCamera(deltaTime);
    updateHUD();
    drawScene();

    requestAnimationFrame(render);
}

// ============================ Initialization & Main ============================
function init() {
    const canvas = document.getElementById('glCanvas');
    gl = canvas.getContext('webgl', { antialias: true, alpha: false, stencil: false, depth: true });
    if (!gl) { alert('WebGL not supported!'); return; }
    
    mainProgram = initShaderProgram(gl, vsSource, fsSource);
    skyProgram = initShaderProgram(gl, skyVsSource, skyFsSource);

    if (!mainProgram || !skyProgram) {
        console.error("Shader program failed to initialize. See error logs.");
        return;
    }

    mainProgramInfo = {
        program: mainProgram,
        attribLocations: {
            vertexPosition: gl.getAttribLocation(mainProgram, 'aVertexPosition'),
            vertexNormal: gl.getAttribLocation(mainProgram, 'aVertexNormal'),
            materialId: gl.getAttribLocation(mainProgram, 'aMaterialId'),
        },
        uniformLocations: {
            projectionMatrix: gl.getUniformLocation(mainProgram, 'uProjectionMatrix'),
            viewMatrix: gl.getUniformLocation(mainProgram, 'uViewMatrix'),
            modelMatrix: gl.getUniformLocation(mainProgram, 'uModelMatrix'),
            cameraPosition: gl.getUniformLocation(mainProgram, 'uCameraPosition'),
            normalMatrix: gl.getUniformLocation(mainProgram, 'uNormalMatrix'),
        },
    };
    skyProgramInfo = {
        program: skyProgram,
        attribLocations: { vertexPosition: gl.getAttribLocation(skyProgram, 'aVertexPosition'), },
        uniformLocations: { projectionMatrix: gl.getUniformLocation(skyProgram, 'uProjectionMatrix'), viewMatrix: gl.getUniformLocation(skyProgram, 'uViewMatrix'), },
    };

    playerBuffers = createPlayerBuffers();
    cubeBuffers = createCubeBuffers();
    skyBuffers = createCubeBuffers(2000.0);

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);

    initInput();
    setupUI();
    requestAnimationFrame(render);
}

window.onload = init;

'use strict';

window.addEventListener('DOMContentLoaded', () => {

    // --- 1. GLOBAL STATE & CONSTANTS ---
    const canvas = document.getElementById('glcanvas');
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, stencil: false, depth: true });

    if (!gl) {
        alert('Unable to initialize WebGL. Your browser or machine may not support it.');
        return;
    }
    
    // Game state
    const game = {
        state: 'menu', // menu, playing, paused, dead, finished
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

    // Physics constants
    const PHYSICS_TICK_RATE = 1 / 60;
    const MAX_UPDATES_PER_FRAME = 5;
    const GRAVITY = -25.0;
    const JUMP_IMPULSE = 12.0;
    const COYOTE_TIME = 0.08; // 80ms

    // Reusable math objects to prevent per-frame allocation
    const temp = {
        mat4: mat4.create(),
        vec3: vec3.create(),
        vec3_2: vec3.create(),
        quat: quat.create(),
    };
    const UP_VECTOR = vec3.fromValues(0, 1, 0);

    // --- 2. SHADERS (Inlined GLSL) ---

    // Main shader for track, player, and obstacles
    const vsSource = `
        attribute vec4 aVertexPosition;
        attribute vec3 aVertexNormal;
        attribute float aMaterialId;

        uniform mat4 uProjectionMatrix;
        uniform mat4 uViewMatrix;
        uniform mat4 uModelMatrix;
        uniform mat4 uNormalMatrix;
        
        varying highp vec3 vWorldPosition;
        varying highp vec3 vNormal;
        varying highp float vMaterialId;

        void main(void) {
            vec4 worldPos = uModelMatrix * aVertexPosition;
            gl_Position = uProjectionMatrix * uViewMatrix * worldPos;
            vWorldPosition = worldPos.xyz;
            vNormal = (uNormalMatrix * vec4(aVertexNormal, 0.0)).xyz;
            vMaterialId = aMaterialId;
        }
    `;

    const fsSource = `
        precision highp float;

        varying highp vec3 vWorldPosition;
        varying highp vec3 vNormal;
        varying highp float vMaterialId;
        
        uniform vec3 uLightDirection;
        uniform vec3 uCameraPosition;

        const vec3 FOG_COLOR = vec3(0.01, 0.015, 0.025);
        const float FOG_DENSITY = 0.003;

        // Material Colors (matches MATERIAL enum)
        const vec3 colors[8] = vec3[](
            vec3(0.6, 0.65, 0.7),   // Normal 0
            vec3(0.9, 0.2, 0.2),   // Hazard 1
            vec3(0.2, 0.9, 0.2),   // Boost 2
            vec3(0.7, 0.9, 1.0),   // Ice 3
            vec3(0.9, 0.7, 0.1),   // Fuel 4
            vec3(0.1, 0.7, 0.9),   // Oxygen 5
            vec3(0.8, 0.2, 0.8),   // Finish 6
            vec3(0.9, 0.9, 0.9)    // Player 7
        );

        void main(void) {
            vec3 normal = normalize(vNormal);
            float lambert = max(dot(normal, normalize(uLightDirection)), 0.2); // Ambient light 0.2
            
            vec3 materialColor = colors[int(vMaterialId)];
            vec3 finalColor = materialColor * lambert;

            // Player ship fresnel effect
            if (vMaterialId > 6.5) {
                 vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
                 float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.0);
                 finalColor += vec3(0.5, 0.8, 1.0) * fresnel * 0.5;
            }

            // Fog
            float dist = length(uCameraPosition - vWorldPosition);
            float fogFactor = exp(-dist * dist * FOG_DENSITY * FOG_DENSITY);
            fogFactor = clamp(fogFactor, 0.0, 1.0);

            // Vignette
            vec2 screenPos = gl_FragCoord.xy / vec2(1280.0, 720.0); // Assuming a base resolution
            float vignette = 1.0 - smoothstep(0.4, 1.0, length(screenPos - 0.5));
            
            gl_FragColor = vec4(mix(FOG_COLOR, finalColor, fogFactor) - vignette * 0.2, 1.0);
        }
    `;

    // Sky shader
    const skyVsSource = `
        attribute vec4 aVertexPosition;
        varying highp vec3 vWorldPosition;
        uniform mat4 uProjectionMatrix;
        uniform mat4 uViewMatrix;
        
        void main() {
            // Remove translation from view matrix for skybox effect
            mat4 view = uViewMatrix;
            view[12] = view[13] = view[14] = 0.0;
            gl_Position = uProjectionMatrix * view * aVertexPosition;
            // Send position to fragment shader to calculate gradient
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
            vec3 finalColor;
            if (h > 0.0) {
                finalColor = mix(HORIZON_COLOR, TOP_COLOR, h);
            } else {
                finalColor = mix(HORIZON_COLOR, BOTTOM_COLOR, -h);
            }
            gl_FragColor = vec4(finalColor, 1.0);
        }
    `;

    // --- 3. WEBGL SETUP ---
    let mainProgram, skyProgram;
    let mainProgramInfo, skyProgramInfo;
    let trackBuffers, playerBuffers, cubeBuffers, skyBuffers;
    
    const projectionMatrix = mat4.create();
    const viewMatrix = mat4.create();
    
    function initWebGL() {
        mainProgram = initShaderProgram(gl, vsSource, fsSource);
        skyProgram = initShaderProgram(gl, skyVsSource, skyFsSource);

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
                normalMatrix: gl.getUniformLocation(mainProgram, 'uNormalMatrix'),
                lightDirection: gl.getUniformLocation(mainProgram, 'uLightDirection'),
                cameraPosition: gl.getUniformLocation(mainProgram, 'uCameraPosition'),
            },
        };

        skyProgramInfo = {
            program: skyProgram,
            attribLocations: {
                vertexPosition: gl.getAttribLocation(skyProgram, 'aVertexPosition'),
            },
            uniformLocations: {
                projectionMatrix: gl.getUniformLocation(skyProgram, 'uProjectionMatrix'),
                viewMatrix: gl.getUniformLocation(skyProgram, 'uViewMatrix'),
            },
        };

        // Create buffers for basic shapes
        playerBuffers = createPlayerBuffers();
        cubeBuffers = createCubeBuffers();
        skyBuffers = createCubeBuffers(2000.0); // Large cube for skybox

        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.CULL_FACE);
    }
    
    // --- 4. PLAYER & CAMERA ---
    const player = {
        pos: vec3.create(),
        vel: vec3.create(),
        size: vec3.fromValues(0.8, 1.0, 1.5), // width, height, length
        onGround: false,
        coyoteTimeLeft: 0,
        jumpReleased: true,
        
        // Resources & State
        fuel: 100,
        oxygen: 100,
        speed: 0,
        speedTarget: 80.0, // m/s
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

    function resetPlayer(toCheckpoint = false) {
        if(toCheckpoint && game.level) {
            vec3.set(player.pos, 0, 2, game.lastCheckpointZ);
        } else if (game.level) {
            vec3.copy(player.pos, game.level.playerStart.pos);
            game.lastCheckpointZ = game.level.playerStart.pos[2];
        }
        vec3.set(player.vel, 0, 0, 0);
        player.onGround = false;
        player.speedTarget = player.baseSpeed;
        player.boostTimer = 0;

        if (!toCheckpoint) {
            player.fuel = game.level.fuelStart;
            player.oxygen = game.level.oxygenStart;
        }
    }

    function updateCamera(dt) {
        // Desired position is behind and above the player
        const desiredPos = temp.vec3;
        vec3.scale(desiredPos, player.vel, 0.1); // Look ahead based on velocity
        vec3.add(desiredPos, player.pos, desiredPos);
        desiredPos[1] += camera.height;
        desiredPos[2] -= camera.distance;

        // Smoothly interpolate to the desired position
        vec3.lerp(camera.pos, camera.pos, desiredPos, camera.smoothSpeed * dt);

        // Target is slightly in front of the player
        const targetPos = temp.vec3_2;
        vec3.copy(targetPos, player.pos);
        targetPos[1] += 1.0; // Look at the body of the ship, not the floor
        targetPos[2] += camera.lookAhead;

        mat4.lookAt(viewMatrix, camera.pos, targetPos, UP_VECTOR);
    }


    // --- 5. INPUT HANDLING ---
    const input = {
        keys: new Set(),
        gamepad: null,
    };

    function initInput() {
        window.addEventListener('keydown', e => {
            input.keys.add(e.code);
            if (e.code === 'KeyP') {
                if (game.state === 'playing') pauseGame();
                else if (game.state === 'paused') resumeGame();
            }
            if (e.code === 'KeyR' && (game.state === 'playing' || game.state === 'dead')) {
                handlePlayerDeath(true); // Reset to checkpoint
            }
            if(e.code === 'F3') {
                e.preventDefault();
                game.debug.panel = !game.debug.panel;
                document.getElementById('debug-panel').style.display = game.debug.panel ? 'block' : 'none';
            }
        });
        window.addEventListener('keyup', e => input.keys.delete(e.code));
        
        // Debug checkboxes
        document.getElementById('debug-colliders').addEventListener('change', e => game.debug.showColliders = e.target.checked);
        document.getElementById('debug-wireframe').addEventListener('change', e => game.debug.wireframe = e.target.checked);
    }

    function pollGamepad() {
        if (!navigator.getGamepads) return;
        const gp = navigator.getGamepads()[0];
        input.gamepad = gp;
    }


    // --- 6. PHYSICS & COLLISION ---
    function updatePhysics(dt) {
        if (game.state !== 'playing') return;
        
        pollGamepad(); // Poll gamepad state each physics frame

        // 1. Apply Controls
        let accel = 0;
        let strafe = 0;

        // Keyboard
        if (input.keys.has('KeyW') || input.keys.has('ArrowUp')) accel = 1.0;
        if (input.keys.has('KeyS') || input.keys.has('ArrowDown')) accel = -1.0;
        if (input.keys.has('KeyA') || input.keys.has('ArrowLeft')) strafe = -1.0;
        if (input.keys.has('KeyD') || input.keys.has('ArrowRight')) strafe = 1.0;

        // Gamepad
        if (input.gamepad) {
            if (input.gamepad.buttons[7]?.pressed) accel = input.gamepad.buttons[7].value; // RT
            if (input.gamepad.buttons[6]?.pressed) accel = -input.gamepad.buttons[6].value; // LT
            const stickX = input.gamepad.axes[0];
            if (Math.abs(stickX) > 0.15) strafe = stickX;
        }

        // Forward/backward acceleration
        const targetZVel = player.speedTarget * (accel > 0 ? 1 : 0.5);
        const accelRate = accel > 0 ? 100.0 : 200.0;
        player.vel[2] = lerp(player.vel[2], (accel !== 0) ? targetZVel * Math.sign(accel) : player.vel[2] * 0.98, accelRate * dt);
        player.vel[2] = clamp(player.vel[2], -player.baseSpeed * 0.5, player.speedTarget * 1.5);

        // Strafing
        const strafeControl = player.onGround ? 25.0 : 10.0; // Less control in air
        if (input.keys.has('ShiftLeft')) strafeControl *= 0.5;
        player.vel[0] += strafe * strafeControl * dt;
        
        // Jumping
        const jumpPressed = input.keys.has('Space') || input.gamepad?.buttons[0]?.pressed;
        if (jumpPressed && player.jumpReleased && (player.onGround || player.coyoteTimeLeft > 0)) {
            player.vel[1] = JUMP_IMPULSE;
            player.onGround = false;
            player.coyoteTimeLeft = 0;
            player.jumpReleased = false;
        }
        if (!jumpPressed) {
            player.jumpReleased = true;
        }
        
        // 2. Apply world forces (Gravity & Friction)
        if (!player.onGround) {
            player.vel[1] += GRAVITY * dt;
            player.coyoteTimeLeft -= dt;
        } else {
            player.coyoteTimeLeft = COYOTE_TIME;
        }
        
        // Friction / Drag
        const friction = player.onGround ? 1.0 : 0.1;
        player.vel[0] *= (1 - 2.0 * friction * dt); // Sideways friction
        if (accel === 0) {
            player.vel[2] *= (1 - 0.5 * friction * dt); // Forward friction when not accelerating
        }

        // 3. Integrate position
        vec3.scaleAndAdd(player.pos, player.pos, player.vel, dt);
        
        // 4. Collision Detection & Response
        player.onGround = false;
        const playerBox = getPlayerAABB();
        let currentSegment = null;

        // Broadphase: Check nearby segments
        const checkRadius = 5;
        const playerSegIdx = findSegmentIndexAt(player.pos[2]);

        for (let i = Math.max(0, playerSegIdx - checkRadius); i < Math.min(game.track.segments.length, playerSegIdx + checkRadius); i++) {
            const segment = game.track.segments[i];
            
            // Simple AABB vs AABB check
            if (playerBox.maxX > segment.aabb.minX && playerBox.minX < segment.aabb.maxX &&
                playerBox.maxZ > segment.aabb.minZ && playerBox.minZ < segment.aabb.maxZ) {
                
                // Narrowphase: Check vertical collision
                if (playerBox.minY < segment.aabb.maxY && playerBox.maxY > segment.aabb.minY) {
                    
                    // Collision! Resolve it.
                    // This is a simplified resolution. A real one would use swept collision.
                    const overlapY = segment.aabb.maxY - playerBox.minY;
                    if (overlapY > 0 && player.vel[1] <= 0) {
                        player.pos[1] += overlapY;
                        player.vel[1] = 0;
                        player.onGround = true;
                        currentSegment = segment;
                        break; // Assume only one ground collision per frame
                    }
                }
            }
        }
        
        // 5. Apply tile effects if on ground
        if (player.onGround && currentSegment) {
            handleMaterial(currentSegment.material);
        }

        // 6. Update resources & check death conditions
        // Fuel drains with acceleration
        if (accel > 0) {
            player.fuel -= game.level.fuelDrainPerSec * dt * (player.vel[2] / player.baseSpeed);
        }
        // Oxygen drains constantly
        player.oxygen -= game.level.oxygenDrainPerSec * dt;
        
        if (player.boostTimer > 0) {
            player.boostTimer -= dt;
            if (player.boostTimer <= 0) {
                player.speedTarget = player.baseSpeed;
            }
        }
        player.speed = vec3.length(player.vel);

        // Check death
        if (player.pos[1] < -50 || player.fuel <= 0 || player.oxygen <= 0) {
            handlePlayerDeath();
        }

        // Check finish
        if(player.pos[2] > game.level.finishZ) {
            finishLevel();
        }

        // Checkpoints every 500m
        if (Math.floor(player.pos[2] / 500) > Math.floor(game.lastCheckpointZ / 500)) {
            game.lastCheckpointZ = Math.floor(player.pos[2] / 500) * 500;
        }

    }

    function handleMaterial(material) {
        const MAT = MATERIALS;
        switch(material.id) {
            case MAT.HAZARD.id:
                handlePlayerDeath();
                break;
            case MAT.BOOST.id:
                player.speedTarget = player.baseSpeed * 1.8;
                player.boostTimer = 3.0; // 3 seconds of boost
                break;
            case MAT.ICE.id:
                // Lower friction is handled by modifying strafe control and friction values
                player.vel[0] *= (1 - 0.2 * 1.0 * PHYSICS_TICK_RATE); // Less sideways friction on ice
                break;
            case MAT.FUEL.id:
                player.fuel = Math.min(100, player.fuel + 50 * PHYSICS_TICK_RATE);
                break;
            case MAT.OXY.id:
                player.oxygen = Math.min(100, player.oxygen + 50 * PHYSICS_TICK_RATE);
                break;
        }
    }
    
    function getPlayerAABB() {
        return {
            minX: player.pos[0] - player.size[0] / 2,
            maxX: player.pos[0] + player.size[0] / 2,
            minY: player.pos[1] - player.size[1] / 2,
            maxY: player.pos[1] + player.size[1] / 2,
            minZ: player.pos[2] - player.size[2] / 2,
            maxZ: player.pos[2] + player.size[2] / 2,
        };
    }

    function findSegmentIndexAt(z) {
        // This could be a binary search if segments are sorted and have precomputed Z ranges
        for (let i = 0; i < game.track.segments.length; i++) {
            if (z >= game.track.segments[i].aabb.minZ && z <= game.track.segments[i].aabb.maxZ) {
                return i;
            }
        }
        // If not inside any segment, find the closest one
        let closest = 0;
        let min_dist = Infinity;
        for (let i = 0; i < game.track.segments.length; i++) {
            let dist = Math.abs(z - (game.track.segments[i].aabb.minZ + game.track.segments[i].aabb.maxZ) / 2);
            if (dist < min_dist) {
                min_dist = dist;
                closest = i;
            }
        }
        return closest;
    }

    // --- 7. LEVEL DATA & TRACK GENERATION ---
    const MATERIALS = {
        NORMAL: { id: 0, color: [0.6, 0.65, 0.7] },
        HAZARD: { id: 1, color: [0.9, 0.2, 0.2] },
        BOOST:  { id: 2, color: [0.2, 0.9, 0.2] },
        ICE:    { id: 3, color: [0.7, 0.9, 1.0] },
        FUEL:   { id: 4, color: [0.9, 0.7, 0.1] },
        OXY:    { id: 5, color: [0.1, 0.7, 0.9] },
        FINISH: { id: 6, color: [0.8, 0.2, 0.8] },
        PLAYER: { id: 7, color: [0.9, 0.9, 0.9] },
    };
    
    const levels = [
        {
            id: 'level1',
            name: "Level 1 - The Basics",
            playerStart: { pos: [0, 2, 10], fwd: [0, 0, 1] },
            finishZ: 1000,
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
            id: 'level2',
            name: "Level 2 - The Gauntlet",
            playerStart: { pos: [0, 2, 10], fwd: [0, 0, 1] },
            finishZ: 1500,
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
                { type: "straight", length: 200, width: 10, material: "HAZARD", pattern: "stripes" },
                { type: "gap", length: 10 },
                { type: "straight", length: 300, material: "NORMAL" },
                { type: "curve", length: 200, yaw: 0.8, material: "NORMAL" },
                { type: "gap", length: 10 },
                { type: "platform", length: 20, width: 20, material: "OXY" },
                { type: "straight", length: 250, material: "NORMAL" },
                { type: "straight", length: 20, material: "FINISH" },
            ]
        }
    ];

    function generateEndlessLevel() {
        const segments = [{ type: "straight", length: 50, width: 10, material: "NORMAL" }];
        let segmentCount = 100; // Generate a long track
        const rand = (min, max) => Math.random() * (max - min) + min;

        for (let i = 0; i < segmentCount; i++) {
            const r = Math.random();
            if (r < 0.4) { // Straight
                segments.push({ type: 'straight', length: rand(50, 200), width: rand(6, 12), material: 'NORMAL' });
            } else if (r < 0.6) { // Curve
                segments.push({ type: 'curve', length: rand(80, 150), yaw: rand(-0.4, 0.4), width: rand(8, 12), material: 'NORMAL' });
            } else if (r < 0.75) { // Ramp + Gap
                segments.push({ type: 'ramp', length: rand(20, 40), pitch: rand(0.1, 0.3), material: 'BOOST' });
                segments.push({ type: 'gap', length: rand(30, 80) });
            } else { // Special tiles
                const matR = Math.random();
                let material = 'NORMAL';
                if (matR < 0.25) material = 'ICE';
                else if (matR < 0.5) material = 'HAZARD';
                else if (matR < 0.75) material = 'FUEL';
                else material = 'OXY';
                segments.push({ type: 'platform', length: rand(20, 50), width: rand(15, 25), material });
                segments.push({ type: 'gap', length: rand(10, 25) });
            }
        }
        segments.push({ type: 'straight', length: 20, material: 'FINISH' });
        
        let totalZ = segments.reduce((acc, s) => acc + s.length, 0);

        return {
            id: 'endless',
            name: "Endless Mode",
            playerStart: { pos: [0, 2, 10], fwd: [0, 0, 1] },
            finishZ: totalZ - 50,
            oxygenStart: 100, fuelStart: 100,
            oxygenDrainPerSec: 3, fuelDrainPerSec: 5,
            segments: segments,
        };
    }
    
    function buildTrack(level) {
        const vertices = [], indices = [], normals = [], materialIds = [];
        const segments = [];
        let currentIndex = 0;

        const currentPos = vec3.fromValues(0, 0, 0);
        const currentRot = quat.create();

        for (const segDef of level.segments) {
            const type = segDef.type;
            if (type === 'gap') {
                currentPos[2] += segDef.length;
                continue;
            }

            const length = segDef.length;
            const width = segDef.width || 10;
            const height = segDef.height || 1.0;
            const material = MATERIALS[segDef.material] || MATERIALS.NORMAL;

            const modelMatrix = mat4.create();
            mat4.fromRotationTranslation(modelMatrix, currentRot, currentPos);
            
            if (segDef.pitch) {
                const pitchQuat = quat.setAxisAngle(temp.quat, [1, 0, 0], segDef.pitch);
                mat4.rotate(modelMatrix, modelMatrix, pitchQuat);
            }
            
            const aabb = {
                minX: -width / 2, maxX: width / 2,
                minY: -height, maxY: 0,
                minZ: 0, maxZ: length
            };
            
            // Transform AABB to world space
            const corners = [
                [aabb.minX, aabb.minY, aabb.minZ], [aabb.maxX, aabb.minY, aabb.minZ],
                [aabb.minX, aabb.maxY, aabb.minZ], [aabb.maxX, aabb.maxY, aabb.minZ],
                [aabb.minX, aabb.minY, aabb.maxZ], [aabb.maxX, aabb.minY, aabb.maxZ],
                [aabb.minX, aabb.maxY, aabb.maxZ], [aabb.maxX, aabb.maxY, aabb.maxZ],
            ];
            
            const worldAABB = {
                minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity
            };
            corners.forEach(c => {
                const worldCorner = vec3.transformMat4(temp.vec3, c, modelMatrix);
                worldAABB.minX = Math.min(worldAABB.minX, worldCorner[0]);
                worldAABB.maxX = Math.max(worldAABB.maxX, worldCorner[0]);
                worldAABB.minY = Math.min(worldAABB.minY, worldCorner[1]);
                worldAABB.maxY = Math.max(worldAABB.maxY, worldCorner[2]);
                worldAABB.minZ = Math.min(worldAABB.minZ, worldCorner[2]);
                worldAABB.maxZ = Math.max(worldAABB.maxZ, worldCorner[2]);
            });
            worldAABB.maxY = currentPos[1]; // simplified for flat top surfaces
            worldAABB.minY = currentPos[1] - height;

            segments.push({
                ...segDef,
                modelMatrix: modelMatrix,
                material: material,
                aabb: worldAABB
            });

            const tileCount = Math.max(1, Math.round(length / width));
            for (let i = 0; i < tileCount; i++) {
                const z = (i / tileCount) * length;
                const tileLength = length / tileCount;
                
                const tileVerts = [
                    // Top face
                    -width / 2, 0, z,              width / 2, 0, z,
                     width / 2, 0, z + tileLength, -width / 2, 0, z + tileLength,
                ];
                const tileNormals = [ 0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0 ];
                const tileIndices = [ 0, 1, 2,  0, 2, 3 ];

                for(let j=0; j < tileVerts.length; j+=3){
                    const localPos = vec3.fromValues(tileVerts[j], tileVerts[j+1], tileVerts[j+2]);
                    vec3.transformMat4(localPos, localPos, modelMatrix);
                    vertices.push(localPos[0], localPos[1], localPos[2]);
                    materialIds.push(material.id);
                }
                
                for(let j=0; j < tileNormals.length; j+=3){
                    const localNormal = vec3.fromValues(tileNormals[j], tileNormals[j+1], tileNormals[j+2]);
                    const normalMatrix = mat4.invert(temp.mat4, modelMatrix);
                    mat4.transpose(normalMatrix, normalMatrix);
                    vec3.transformMat4(localNormal, localNormal, normalMatrix);
                    vec3.normalize(localNormal, localNormal);
                    normals.push(localNormal[0], localNormal[1], localNormal[2]);
                }
                
                tileIndices.forEach(idx => indices.push(currentIndex + idx));
                currentIndex += 4;
            }
            
            // Advance cursor for next segment
            const forward = vec3.fromValues(0, 0, length);
            if (segDef.pitch) {
                const pitchQuat = quat.setAxisAngle(temp.quat, [1, 0, 0], segDef.pitch);
                vec3.transformQuat(forward, forward, pitchQuat);
            }
            vec3.transformQuat(forward, forward, currentRot);
            vec3.add(currentPos, currentPos, forward);

            if (segDef.yaw) {
                const yawQuat = quat.setAxisAngle(temp.quat, [0, 1, 0], segDef.yaw);
                quat.multiply(currentRot, currentRot, yawQuat);
            }
        }

        return { vertices, indices, normals, materialIds, segments };
    }


    // --- 8. RENDERING ---
    function render(time) {
        time *= 0.001; // convert to seconds
        const deltaTime = time - game.lastTime;
        game.lastTime = time;

        if (game.state === 'playing') {
            game.time += deltaTime;
        }

        // Update FPS counter (Exponential Moving Average)
        game.fps = 0.95 * game.fps + 0.05 * (1 / deltaTime);
        
        // Fixed timestep physics loop
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
    
    function drawScene() {
        resizeCanvasToDisplaySize(gl.canvas);
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        mat4.perspective(projectionMatrix, 45 * Math.PI / 180, gl.canvas.clientWidth / gl.canvas.clientHeight, 0.1, 4000.0);

        // Draw Skybox
        drawSky();
        
        // Draw Track & Player
        gl.useProgram(mainProgramInfo.program);
        gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.projectionMatrix, false, projectionMatrix);
        gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.viewMatrix, false, viewMatrix);
        gl.uniform3fv(mainProgramInfo.uniformLocations.lightDirection, vec3.normalize(temp.vec3, [-0.5, -1, -0.2]));
        gl.uniform3fv(mainProgramInfo.uniformLocations.cameraPosition, camera.pos);
        
        drawTrack();
        drawPlayer();
        
        if (game.debug.showColliders) {
            drawColliders();
        }
    }
    
    function drawTrack() {
        if (!trackBuffers) return;

        // "Emulate" VAO by binding all buffers and attributes for this object
        gl.bindBuffer(gl.ARRAY_BUFFER, trackBuffers.position);
        gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexPosition);

        gl.bindBuffer(gl.ARRAY_BUFFER, trackBuffers.normal);
        gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexNormal, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexNormal);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, trackBuffers.materialId);
        gl.vertexAttribPointer(mainProgramInfo.attribLocations.materialId, 1, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(mainProgramInfo.attribLocations.materialId);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, trackBuffers.indices);
        
        // For static track, model matrix is identity
        mat4.identity(temp.mat4);
        gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.modelMatrix, false, temp.mat4);
        gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.normalMatrix, false, temp.mat4); // Normal matrix is also identity

        gl.drawElements(game.debug.wireframe ? gl.LINES : gl.TRIANGLES, trackBuffers.vertexCount, gl.UNSIGNED_SHORT, 0);
    }

    function drawPlayer() {
        gl.bindBuffer(gl.ARRAY_BUFFER, playerBuffers.position);
        gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexPosition);

        gl.bindBuffer(gl.ARRAY_BUFFER, playerBuffers.normal);
        gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexNormal, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexNormal);

        gl.bindBuffer(gl.ARRAY_BUFFER, playerBuffers.materialId);
        gl.vertexAttribPointer(mainProgramInfo.attribLocations.materialId, 1, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(mainProgramInfo.attribLocations.materialId);
        
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, playerBuffers.indices);

        const modelMatrix = temp.mat4;
        mat4.fromTranslation(modelMatrix, player.pos);
        // Optional: bank the ship based on sideways velocity
        const bankAngle = -player.vel[0] * 0.05;
        mat4.rotateZ(modelMatrix, modelMatrix, bankAngle);

        gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.modelMatrix, false, modelMatrix);

        const normalMatrix = mat4.invert(temp.mat4_2, modelMatrix);
        mat4.transpose(normalMatrix, normalMatrix);
        gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.normalMatrix, false, normalMatrix);

        gl.drawElements(gl.TRIANGLES, playerBuffers.vertexCount, gl.UNSIGNED_SHORT, 0);
    }
    
    function drawColliders() {
        if (!game.track) return;
        
        gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffers.position);
        gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexPosition);

        gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffers.normal);
        gl.vertexAttribPointer(mainProgramInfo.attribLocations.vertexNormal, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(mainProgramInfo.attribLocations.vertexNormal);
        
        gl.disableVertexAttribArray(mainProgramInfo.attribLocations.materialId);
        gl.vertexAttrib1f(mainProgramInfo.attribLocations.materialId, MATERIALS.PLAYER.id);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cubeBuffers.indices);

        game.track.segments.forEach(seg => {
            const aabb = seg.aabb;
            const center = [(aabb.minX + aabb.maxX)/2, (aabb.minY + aabb.maxY)/2, (aabb.minZ + aabb.maxZ)/2];
            const size = [aabb.maxX - aabb.minX, aabb.maxY - aabb.minY, aabb.maxZ - aabb.minZ];

            const modelMatrix = mat4.create();
            mat4.fromTranslation(modelMatrix, center);
            mat4.scale(modelMatrix, modelMatrix, size);
            
            gl.uniformMatrix4fv(mainProgramInfo.uniformLocations.modelMatrix, false, modelMatrix);
            gl.drawElements(gl.LINES, cubeBuffers.wireframeVertexCount, gl.UNSIGNED_SHORT, 0);
        });
    }

    function drawSky() {
        gl.useProgram(skyProgramInfo.program);
        gl.depthMask(false); // Don't write to depth buffer

        gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffers.position);
        gl.vertexAttribPointer(skyProgramInfo.attribLocations.vertexPosition, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(skyProgramInfo.attribLocations.vertexPosition);
        
        gl.uniformMatrix4fv(skyProgramInfo.uniformLocations.projectionMatrix, false, projectionMatrix);
        gl.uniformMatrix4fv(skyProgramInfo.uniformLocations.viewMatrix, false, viewMatrix);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, skyBuffers.indices);
        gl.drawElements(gl.TRIANGLES, skyBuffers.vertexCount, gl.UNSIGNED_SHORT, 0);

        gl.depthMask(true);
    }

    // --- 9. HUD & UI MANAGEMENT ---
    const hud = {
        levelName: document.getElementById('level-name'),
        speed: document.getElementById('speed-value'),
        distance: document.getElementById('distance-value'),
        lives: document.getElementById('lives-value'),
        time: document.getElementById('time-value'),
        fps: document.getElementById('fps-value'),
        fuelFill: document.getElementById('fuel-fill'),
        oxygenFill: document.getElementById('oxygen-fill'),
        mainMenu: document.getElementById('main-menu-overlay'),
        pauseMenu: document.getElementById('pause-overlay'),
        resultsMenu: document.getElementById('results-overlay'),
    };
    const debugUI = {
        pos: document.getElementById('debug-pos'),
        vel: document.getElementById('debug-vel'),
        ground: document.getElementById('debug-ground'),
        segment: document.getElementById('debug-segment'),
        segType: document.getElementById('debug-seg-type'),
    };
    
    function updateHUD() {
        hud.speed.textContent = (player.speed * 3.6).toFixed(0);
        hud.distance.textContent = player.pos[2].toFixed(0);
        hud.lives.textContent = game.lives;
        hud.time.textContent = game.time.toFixed(2);
        hud.fps.textContent = game.fps.toFixed(0);

        hud.fuelFill.style.width = clamp(player.fuel, 0, 100) + '%';
        hud.fuelFill.classList.toggle('low', player.fuel < 20);
        
        hud.oxygenFill.style.width = clamp(player.oxygen, 0, 100) + '%';
        hud.oxygenFill.classList.toggle('low', player.oxygen < 20);
        
        if(game.debug.panel) {
            debugUI.pos.textContent = `${player.pos[0].toFixed(1)}, ${player.pos[1].toFixed(1)}, ${player.pos[2].toFixed(1)}`;
            debugUI.vel.textContent = `${player.vel[0].toFixed(1)}, ${player.vel[1].toFixed(1)}, ${player.vel[2].toFixed(1)}`;
            debugUI.ground.textContent = player.onGround;
            const segIdx = findSegmentIndexAt(player.pos[2]);
            debugUI.segment.textContent = segIdx;
            if(game.track && game.track.segments[segIdx]) {
                debugUI.segType.textContent = `${game.track.segments[segIdx].type} / ${game.track.segments[segIdx].material.id}`;
            }
        }
    }
    
    function setupUIListeners() {
        // Main Menu
        document.getElementById('start-level-1').addEventListener('click', () => startGame(0));
        document.getElementById('start-level-2').addEventListener('click', () => startGame(1));
        document.getElementById('start-endless').addEventListener('click', () => startGame('endless'));
        // Pause Menu
        document.getElementById('resume-button').addEventListener('click', resumeGame);
        document.getElementById('restart-level-button').addEventListener('click', () => {
             game.lives = 3;
             startGame(game.currentLevelIndex);
        });
        document.getElementById('quit-to-menu-button').addEventListener('click', quitToMenu);
        // Results Menu
        document.getElementById('next-level-button').addEventListener('click', () => startGame(game.currentLevelIndex + 1));
        document.getElementById('results-restart-button').addEventListener('click', () => startGame(game.currentLevelIndex));
        document.getElementById('results-quit-button').addEventListener('click', quitToMenu);
    }
    
    // --- 10. GAME STATE MANAGEMENT ---
    
    function startGame(levelIndex) {
        if (levelIndex === 'endless') {
            game.level = generateEndlessLevel();
        } else if (levelIndex >= levels.length) {
            // Finished all levels, go to menu
            quitToMenu();
            return;
        } else {
            game.level = levels[levelIndex];
        }

        game.currentLevelIndex = levelIndex;
        game.track = buildTrack(game.level);
        trackBuffers = createVbo(game.track);

        resetPlayer(false);
        game.time = 0;
        
        game.state = 'playing';
        hud.mainMenu.classList.remove('visible');
        hud.pauseMenu.classList.remove('visible');
        hud.resultsMenu.classList.remove('visible');
        hud.levelName.textContent = game.level.name;
    }

    function pauseGame() {
        if (game.state !== 'playing') return;
        game.state = 'paused';
        hud.pauseMenu.classList.add('visible');
    }

    function resumeGame() {
        if (game.state !== 'paused') return;
        game.state = 'playing';
        hud.pauseMenu.classList.remove('visible');
    }
    
    function quitToMenu() {
        game.state = 'menu';
        hud.mainMenu.classList.add('visible');
        hud.pauseMenu.classList.remove('visible');
        hud.resultsMenu.classList.remove('visible');
    }

    function handlePlayerDeath(isManualReset = false) {
        if (game.state !== 'playing' && !isManualReset) return;

        game.lives--;
        if (game.lives < 0) {
            // Game Over
            showResults("Game Over", false);
            game.lives = 3; // Reset for next game
        } else {
            // Reset to last checkpoint
            game.state = 'dead';
            setTimeout(() => {
                resetPlayer(true);
                game.state = 'playing';
            }, 1000); // 1s delay before respawn
        }
    }
    
    function finishLevel() {
        if (game.state !== 'playing') return;
        game.state = 'finished';
        showResults("Level Complete!");
    }
    
    function showResults(title, showNext = true) {
        document.getElementById('results-title').textContent = title;
        document.getElementById('results-time').textContent = game.time.toFixed(2) + 's';
        
        const bestTimeKey = `best_time_${game.level.id}`;
        let bestTime = parseFloat(localStorage.getItem(bestTimeKey) || 'Infinity');
        if (game.time < bestTime && title.includes('Complete')) {
            bestTime = game.time;
            localStorage.setItem(bestTimeKey, bestTime.toFixed(2));
        }
        document.getElementById('results-best-time').textContent = isFinite(bestTime) ? bestTime.toFixed(2) + 's' : 'N/A';

        document.getElementById('next-level-button').style.display = showNext ? 'block' : 'none';
        
        hud.resultsMenu.classList.add('visible');
    }

    // --- 11. WEBGL & MATH HELPERS ---
    
    function initShaderProgram(gl, vsSource, fsSource) {
        const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
        const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);
        const shaderProgram = gl.createProgram();
        gl.attachShader(shaderProgram, vertexShader);
        gl.attachShader(shaderProgram, fragmentShader);
        gl.linkProgram(shaderProgram);
        if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
            console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(shaderProgram));
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
    
    function createPlayerBuffers() {
        const s = 0.5; // half-size
        const l = 1.0;
        const vertices = [ // A simple wedge shape
            // Front
            0, s, l,  -s*1.2, -s, -l,  s*1.2, -s, -l,
            // Back
            0, s, -l, -s*0.8, -s, -l,  s*0.8, -s, -l,
            // Top
            0, s, l, 0, s, -l, -s*1.2, -s, -l,  s*1.2, -s, -l,
        ];
        const indices = [ 0, 1, 2,  3, 5, 4,  6,7,8, 6,8,9 ]; // Simplified
        const normals = []; // Normals would need proper calculation
        const materialIds = [];
        for (let i = 0; i < vertices.length / 3; i++) {
            normals.push(0, 1, 0); // Simplified normals
            materialIds.push(MATERIALS.PLAYER.id);
        }
        return createVbo({ vertices, indices, normals, materialIds });
    }

    function createCubeBuffers(size = 1.0) {
        const s = size/2;
        const vertices = [
            // Front face
            -s, -s, s,  s, -s, s,  s, s, s, -s, s, s,
            // Back face
            -s, -s, -s, -s, s, -s, s, s, -s, s, -s, -s,
            // Top face
            -s, s, -s, -s, s, s, s, s, s, s, s, -s,
            // Bottom face
            -s, -s, -s, s, -s, -s, s, -s, s, -s, -s, s,
            // Right face
            s, -s, -s, s, s, -s, s, s, s, s, -s, s,
            // Left face
            -s, -s, -s, -s, -s, s, -s, s, s, -s, s, -s,
        ];
        const indices = [
            0, 1, 2, 0, 2, 3,       // front
            4, 5, 6, 4, 6, 7,       // back
            8, 9, 10, 8, 10, 11,    // top
            12, 13, 14, 12, 14, 15, // bottom
            16, 17, 18, 16, 18, 19, // right
            20, 21, 22, 20, 22, 23, // left
        ];
        const wireframeIndices = [
            0,1, 1,2, 2,3, 3,0, // front
            4,5, 5,6, 6,7, 7,4, // back
            0,4, 1,7, 2,6, 3,5, // connectors
        ];
        const normals = []; // Simplified
        const materialIds = [];
        for (let i=0; i<vertices.length/3; i++) {
            normals.push(0,1,0); materialIds.push(0);
        }
        const buffers = createVbo({ vertices, indices, normals, materialIds });
        buffers.wireframeVertexCount = wireframeIndices.length;
        // Overwrite indices with wireframe indices for debug drawing
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.indices);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(wireframeIndices), gl.STATIC_DRAW);

        return buffers;
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
    
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    // --- 12. MAIN ENTRY POINT ---
    function main() {
        initWebGL();
        initInput();
        setupUIListeners();
        requestAnimationFrame(render);
    }
    
    main();

});

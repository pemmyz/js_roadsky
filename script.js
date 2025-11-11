// ============================ Utility Functions ============================
function toRadian(deg) {
  return deg * Math.PI / 180;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ============================ Shader Sources ============================

// Shader for textured objects like the track
const vsSourceTexture = `
  attribute vec3 aPosition;
  attribute vec2 aTexCoord;
  uniform mat4 uProjection;
  uniform mat4 uView;
  uniform mat4 uModel;
  varying vec2 vTexCoord;
  void main(void) {
      gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
      vTexCoord = aTexCoord;
  }
`;
const fsSourceTexture = `
  precision mediump float;
  varying vec2 vTexCoord;
  uniform sampler2D uTexture;
  void main(void) {
      gl_FragColor = texture2D(uTexture, vTexCoord);
  }
`;

// [NEW] Shader for solid-colored objects like the car
const vsSourceColor = `
  attribute vec3 aPosition;
  attribute vec3 aColor;
  uniform mat4 uProjection;
  uniform mat4 uView;
  uniform mat4 uModel;
  varying vec3 vColor;
  void main(void) {
      gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
      vColor = aColor;
  }
`;
const fsSourceColor = `
  precision mediump float;
  varying vec3 vColor;
  void main(void) {
      gl_FragColor = vec4(vColor, 1.0);
  }
`;


// ============================ Shader & Texture Utilities ============================
function loadShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Error compiling shader: " + gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
function initShaderProgram(gl, vsSource, fsSource) {
  const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
  const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vertexShader);
  gl.attachShader(shaderProgram, fragmentShader);
  gl.linkProgram(shaderProgram);
  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    console.error("Error linking shader program: " + gl.getProgramInfoLog(shaderProgram));
    return null;
  }
  return shaderProgram;
}

function createSolidColorTexture(gl, r, g, b) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const pixel = new Uint8Array([r, g, b, 255]);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return texture;
}

function createCheckerboardTexture(gl) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const textureSize = 64;
    const checkSize = textureSize / 2;
    canvas.width = textureSize;
    canvas.height = textureSize;
    
    const color1 = "#C8C8C8"; // Lighter Grey
    const color2 = "#969696"; // Grey
    
    for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
            ctx.fillStyle = (i + j) % 2 === 0 ? color1 : color2;
            ctx.fillRect(i * checkSize, j * checkSize, checkSize, checkSize);
        }
    }

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
}

// ============================ Track Generation ============================
function createTrack(length, seed) {
    let rng = Math.random;
    if (seed !== undefined) {
        let m_w = seed;
        let m_z = 987654321;
        rng = function() {
            m_z = (36969 * (m_z & 65535) + (m_z >> 16)) & 0xffffffff;
            m_w = (18000 * (m_w & 65535) + (m_w >> 16)) & 0xffffffff;
            let result = ((m_z << 16) + m_w) & 0xffffffff;
            result /= 4294967296;
            return result + 0.5;
        }
    }

    const platforms = [];
    let currentX = 0;
    let currentY = 0;
    const platformHeight = 0.5;
    
    const startDepth = 100;
    platforms.push({ x: 0, y: 0, z: startDepth / 2, width: 10, depth: startDepth, height: platformHeight });
    
    let lastPlatformBackEdge = startDepth;

    for (let i = 0; i < length; i++) {
        const minGap = 1.0;
        const maxGap = 1.8; 
        const gap = rng() * (maxGap - minGap) + minGap;

        const width = rng() * 8 + 4;
        const depth = rng() * 15 + 10;
        
        const newPlatformCenterZ = lastPlatformBackEdge + gap + (depth / 2);

        const xShift = (rng() - 0.5) * 10;
        currentX = Math.max(-15, Math.min(15, currentX + xShift));
        if (rng() < 0.2) {
            const yShift = (rng() - 0.5) * 3;
            currentY += yShift;
        }
        
        platforms.push({ x: currentX, y: currentY, z: newPlatformCenterZ, width: width, depth: depth, height: platformHeight });
        
        lastPlatformBackEdge = newPlatformCenterZ + (depth / 2);
    }
    return platforms;
}

// ============================ Geometry Generation ============================
function createCubeGeometry(width, height, depth, checkSize = 1.0) {
    const w = width / 2, h = height / 2, d = depth / 2;
    const uMaxW = width / checkSize;
    const uMaxD = depth / checkSize;
    const vMaxH = height / checkSize;
    const vMaxD = depth / checkSize;

    return new Float32Array([
        // x, y, z, u, v
        -w, -h, d, 0, 0,       w, -h, d, uMaxW, 0,       w, h, d, uMaxW, vMaxH,  -w, -h, d, 0, 0,       w, h, d, uMaxW, vMaxH,  -w, h, d, 0, vMaxH, // Front
        -w, -h, -d, uMaxW, 0,  -w, h, -d, uMaxW, vMaxH,  w, h, -d, 0, vMaxH,      -w, -h, -d, uMaxW, 0,  w, h, -d, 0, vMaxH,      w, -h, -d, 0, 0, // Back
        -w, h, -d, 0, vMaxD,   -w, h, d, 0, 0,          w, h, d, uMaxW, 0,        -w, h, -d, 0, vMaxD,   w, h, d, uMaxW, 0,        w, h, -d, uMaxW, vMaxD, // Top
        -w, -h, -d, 0, 0,      w, -h, -d, uMaxW, 0,      w, -h, d, uMaxW, vMaxD,  -w, -h, -d, 0, 0,      w, -h, d, uMaxW, vMaxD,  -w, -h, d, 0, vMaxD, // Bottom
        w, -h, -d, uMaxD, 0,   w, h, -d, uMaxD, vMaxH,   w, h, d, 0, vMaxH,       w, -h, -d, uMaxD, 0,   w, h, d, 0, vMaxH,       w, -h, d, 0, 0, // Right
        -w, -h, -d, 0, 0,      -w, -h, d, uMaxD, 0,      -w, h, d, uMaxD, vMaxH,  -w, -h, -d, 0, 0,      -w, h, d, uMaxD, vMaxH,  -w, h, -d, uMaxD, vMaxH, // Left
    ]);
}

// [NEW] Creates a cube with vertex color data instead of texture coordinates
function createColoredCubeGeometry(width, height, depth, faceColors) {
    const w = width / 2, h = height / 2, d = depth / 2;
    const { front, back, top, bottom, right, left } = faceColors;

    const vertices = [
        // x,  y,  z,   r,    g,    b
        // Front face
        -w, -h,  d,  ...front,   w, -h,  d,  ...front,   w,  h,  d,  ...front,
        -w, -h,  d,  ...front,   w,  h,  d,  ...front,  -w,  h,  d,  ...front,
        // Back face
        -w, -h, -d,  ...back,   -w,  h, -d,  ...back,    w,  h, -d,  ...back,
        -w, -h, -d,  ...back,    w,  h, -d,  ...back,    w, -h, -d,  ...back,
        // Top face
        -w,  h, -d,  ...top,    -w,  h,  d,  ...top,     w,  h,  d,  ...top,
        -w,  h, -d,  ...top,     w,  h,  d,  ...top,     w,  h, -d,  ...top,
        // Bottom face
        -w, -h, -d,  ...bottom,  w, -h, -d,  ...bottom,  w, -h,  d,  ...bottom,
        -w, -h, -d,  ...bottom,  w, -h,  d,  ...bottom, -w, -h,  d,  ...bottom,
        // Right face
         w, -h, -d,  ...right,   w,  h, -d,  ...right,   w,  h,  d,  ...right,
         w, -h, -d,  ...right,   w,  h,  d,  ...right,   w, -h,  d,  ...right,
        // Left face
        -w, -h, -d,  ...left,   -w, -h,  d,  ...left,   -w,  h,  d,  ...left,
        -w, -h, -d,  ...left,   -w,  h,  d,  ...left,   -w,  h, -d,  ...left
    ];
    return new Float32Array(vertices);
}


// [MODIFIED] Creates a car-like shape using colored cubes
function createCarGeometry() {
    const carColors = {
        top:    [1.0, 0.2, 0.2], // Lighter red
        side:   [0.8, 0.0, 0.0], // Main red
        front:  [0.6, 0.0, 0.0], // Darker red
        bottom: [0.2, 0.0, 0.0], // Very dark red
    };

    const chassisFaceColors = {
        front: carColors.front, back: carColors.front,
        top: carColors.top, bottom: carColors.bottom,
        right: carColors.side, left: carColors.side
    };

    const cabinFaceColors = {
        front: carColors.front, back: carColors.front,
        top: carColors.top, bottom: carColors.top, // Bottom of cabin is top of chassis
        right: carColors.side, left: carColors.side
    };

    const chassisVerts = createColoredCubeGeometry(1.0, 0.3, 2.0, chassisFaceColors);
    for (let i = 0; i < chassisVerts.length; i += 6) {
        chassisVerts[i+1] -= 0.15;
    }
    
    const cabinVerts = createColoredCubeGeometry(0.8, 0.4, 1.0, cabinFaceColors);
    for (let i = 0; i < cabinVerts.length; i += 6) {
        cabinVerts[i+1] += 0.2;
        cabinVerts[i+2] += 0.2;
    }
    
    const combinedVerts = new Float32Array(chassisVerts.length + cabinVerts.length);
    combinedVerts.set(chassisVerts, 0);
    combinedVerts.set(cabinVerts, chassisVerts.length);

    return combinedVerts;
}

function buildTrackGeometry(platforms) {
    const allVerts = [];
    const checkSize = 1.2; 
    for (const p of platforms) {
        const cubeVerts = createCubeGeometry(p.width, p.height, p.depth, checkSize);
        for (let i = 0; i < cubeVerts.length; i += 5) {
            allVerts.push(
                cubeVerts[i] + p.x,
                cubeVerts[i+1] + p.y,
                cubeVerts[i+2] + p.z,
                cubeVerts[i+3],
                cubeVerts[i+4]
            );
        }
    }
    return new Float32Array(allVerts);
}

// ============================ Global Variables ============================
let gl;
let shaderProgramTexture, shaderProgramColor;
let locationsTexture, locationsColor;
let buffers = {};
let textures = {};
let trackData, geometry;
let carPos, carVelocity, cameraTarget, cameraSway = 0;
let score = 0;
let gameState = 'playing';
let controlStyle = 'inverted';
let lastFrameTime = 0;
const keysDown = {};
const GRAVITY = 25.0, FORWARD_SPEED = 25.0, STRAFE_SPEED = 15.0, JUMP_STRENGTH = 10.0;

function respawnPlayer() {
    console.log("Player fell, respawning...");
    vec3.set(carPos, 0, 2, 5);
    vec3.set(carVelocity, 0, 0, 0);
}

function init() {
  carPos = vec3.fromValues(0, 2, 5);
  carVelocity = vec3.fromValues(0, 0, 0);
  cameraTarget = vec3.create();

  const canvas = document.getElementById("glCanvas");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  gl = canvas.getContext("webgl");
  if (!gl) { alert("WebGL not supported."); return; }

  // [MODIFIED] Initialize two separate shader programs
  shaderProgramTexture = initShaderProgram(gl, vsSourceTexture, fsSourceTexture);
  shaderProgramColor = initShaderProgram(gl, vsSourceColor, fsSourceColor);
  
  locationsTexture = {
    attribs: {
        aPosition: gl.getAttribLocation(shaderProgramTexture, "aPosition"),
        aTexCoord: gl.getAttribLocation(shaderProgramTexture, "aTexCoord")
    },
    uniforms: {
        uProjection: gl.getUniformLocation(shaderProgramTexture, "uProjection"),
        uView: gl.getUniformLocation(shaderProgramTexture, "uView"),
        uModel: gl.getUniformLocation(shaderProgramTexture, "uModel"),
        uTexture: gl.getUniformLocation(shaderProgramTexture, "uTexture")
    }
  };
  locationsColor = {
    attribs: {
        aPosition: gl.getAttribLocation(shaderProgramColor, "aPosition"),
        aColor: gl.getAttribLocation(shaderProgramColor, "aColor")
    },
    uniforms: {
        uProjection: gl.getUniformLocation(shaderProgramColor, "uProjection"),
        uView: gl.getUniformLocation(shaderProgramColor, "uView"),
        uModel: gl.getUniformLocation(shaderProgramColor, "uModel")
    }
  };
    
  textures.track = createCheckerboardTexture(gl);
  
  trackData = createTrack(100, 12345); 
  geometry = buildTrackGeometry(trackData);
  initBuffers();
  
  gl.clearColor(0.20, 0.28, 0.34, 1.0);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  setupEventListeners();
  
  lastFrameTime = performance.now();
  requestAnimationFrame(render);
}

function initBuffers() {
  if (buffers.track) gl.deleteBuffer(buffers.track.buffer);
  if (buffers.car) gl.deleteBuffer(buffers.car.buffer);
  
  const trackVerts = buildTrackGeometry(trackData);
  buffers.track = {
    buffer: initBuffer(trackVerts),
    vertexCount: trackVerts.length / 5 // 5 components per vertex (x,y,z,u,v)
  };
  
  const carVerts = createCarGeometry();
  buffers.car = {
    buffer: initBuffer(carVerts),
    vertexCount: carVerts.length / 6 // 6 components per vertex (x,y,z,r,g,b)
  };
}

function initBuffer(dataArray) {
  if (!dataArray || dataArray.length === 0) return null;
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, dataArray, gl.STATIC_DRAW);
  return buffer;
}

// ============================ Event Listeners & Game State ============================
function toggleHelpMenu() {
    const menu = document.getElementById('helpMenu');
    if (gameState === 'playing') {
        gameState = 'paused';
        menu.classList.remove('hidden');
    } else if (gameState === 'paused') {
        gameState = 'playing';
        menu.classList.add('hidden');
        lastFrameTime = performance.now();
    }
}

function setupEventListeners() {
    window.addEventListener("keydown", e => { 
        const key = e.key.toLowerCase();
        if (key === 'h') {
            toggleHelpMenu();
        } else {
            keysDown[key] = true; 
        }
    });
    window.addEventListener("keyup",   e => { keysDown[e.key.toLowerCase()] = false; });

    document.getElementById('help-toggle-button').addEventListener('click', toggleHelpMenu);
    document.getElementById('close-help-btn').addEventListener('click', toggleHelpMenu);

    const btnInverted = document.getElementById('controlsInverted');
    const btnNormal = document.getElementById('controlsNormal');
    const cameraDesc = document.getElementById('camera-desc');

    btnInverted.addEventListener('click', () => {
        controlStyle = 'inverted';
        btnInverted.classList.add('active');
        btnNormal.classList.remove('active');
        cameraDesc.textContent = "Camera swings out during turns.";
    });

    btnNormal.addEventListener('click', () => {
        controlStyle = 'normal';
        btnNormal.classList.add('active');
        btnInverted.classList.remove('active');
        cameraDesc.textContent = "Camera remains fixed behind the car.";
    });
}


// ============================ Render Loop ============================
function render(now) {
  requestAnimationFrame(render);

  if (gameState === 'paused') {
      return;
  }

  const deltaTime = Math.min(0.1, (now - lastFrameTime) / 1000.0);
  lastFrameTime = now;
  
  updateCar(deltaTime);
  score = Math.max(score, Math.floor(carPos[2]));

  drawScene();
  updateHUD();
}

function updateCar(deltaTime) {
    let onGround = false;
    for (const p of trackData) {
        const halfWidth = p.width / 2, halfDepth = p.depth / 2, platformTop = p.y + p.height / 2;
        if (carPos[0] >= p.x - halfWidth && carPos[0] <= p.x + halfWidth && carPos[2] >= p.z - halfDepth && carPos[2] <= p.z + halfDepth) {
            if (carPos[1] <= platformTop + 0.3 && carPos[1] >= platformTop - 0.5) {
                onGround = true;
                carPos[1] = platformTop + 0.3; 
                if (carVelocity[1] < 0) carVelocity[1] = 0;
            }
        }
    }
    
    let strafe = 0;
    if (keysDown['a'] || keysDown['arrowleft']) strafe = 1;
    else if (keysDown['d'] || keysDown['arrowright']) strafe = -1;
    
    let targetSway = 0;
    if (controlStyle === 'inverted') {
        targetSway = -strafe * 4.0;
    }
    cameraSway = lerp(cameraSway, targetSway, 5.0 * deltaTime);

    if (keysDown[' '] && onGround) {
        carVelocity[1] = JUMP_STRENGTH;
    }

    let forwardSpeed = 0;
    if (keysDown['w'] || keysDown['arrowup']) {
        forwardSpeed = FORWARD_SPEED;
    }
    
    carVelocity[0] = strafe * STRAFE_SPEED;
    carVelocity[2] = forwardSpeed;

    if (!onGround) {
        carVelocity[1] -= GRAVITY * deltaTime;
    }

    vec3.scaleAndAdd(carPos, carPos, carVelocity, deltaTime);

    if (carPos[1] < -20) {
        respawnPlayer();
    }
}

// [MODIFIED] Manages drawing with two different shaders
function drawScene() {
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const projectionMatrix = mat4.create();
    mat4.perspective(projectionMatrix, toRadian(75), gl.canvas.width / gl.canvas.height, 0.1, 1000.0);

    const viewMatrix = mat4.create();
    const cameraOffset = vec3.fromValues(cameraSway, 5, -10); 
    const cameraPos = vec3.create();
    vec3.add(cameraPos, carPos, cameraOffset);
    vec3.lerp(cameraTarget, cameraTarget, carPos, 0.1);
    mat4.lookAt(viewMatrix, cameraPos, cameraTarget, [0, 1, 0]);

    // Draw the track using the texture shader
    const trackModelMatrix = mat4.create();
    drawTexturedObject(buffers.track, textures.track, trackModelMatrix, projectionMatrix, viewMatrix);

    // Draw the car using the color shader
    const carModelMatrix = mat4.create();
    mat4.translate(carModelMatrix, carModelMatrix, carPos);
    drawColoredObject(buffers.car, carModelMatrix, projectionMatrix, viewMatrix);
}

// [MODIFIED] Renamed from drawObject, specifically for textured geometry
function drawTexturedObject(bufferObj, texture, modelMatrix, projectionMatrix, viewMatrix) {
    if (!bufferObj || !bufferObj.buffer || bufferObj.vertexCount === 0) return;
    
    gl.useProgram(shaderProgramTexture);

    const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferObj.buffer);
    gl.vertexAttribPointer(locationsTexture.attribs.aPosition, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(locationsTexture.attribs.aPosition);
    gl.vertexAttribPointer(locationsTexture.attribs.aTexCoord, 2, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);
    gl.enableVertexAttribArray(locationsTexture.attribs.aTexCoord);
    
    gl.uniformMatrix4fv(locationsTexture.uniforms.uProjection, false, projectionMatrix);
    gl.uniformMatrix4fv(locationsTexture.uniforms.uView, false, viewMatrix);
    gl.uniformMatrix4fv(locationsTexture.uniforms.uModel, false, modelMatrix);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(locationsTexture.uniforms.uTexture, 0);
    
    gl.drawArrays(gl.TRIANGLES, 0, bufferObj.vertexCount);
}

// [NEW] Drawing function for objects with vertex colors
function drawColoredObject(bufferObj, modelMatrix, projectionMatrix, viewMatrix) {
    if (!bufferObj || !bufferObj.buffer || bufferObj.vertexCount === 0) return;
    
    gl.useProgram(shaderProgramColor);

    const stride = 6 * Float32Array.BYTES_PER_ELEMENT;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferObj.buffer);
    gl.vertexAttribPointer(locationsColor.attribs.aPosition, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(locationsColor.attribs.aPosition);
    gl.vertexAttribPointer(locationsColor.attribs.aColor, 3, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);
    gl.enableVertexAttribArray(locationsColor.attribs.aColor);

    gl.uniformMatrix4fv(locationsColor.uniforms.uProjection, false, projectionMatrix);
    gl.uniformMatrix4fv(locationsColor.uniforms.uView, false, viewMatrix);
    gl.uniformMatrix4fv(locationsColor.uniforms.uModel, false, modelMatrix);

    gl.drawArrays(gl.TRIANGLES, 0, bufferObj.vertexCount);
}


// ============================ 2D Overlay / HUD ============================
function updateHUD() {
    const overlay = document.getElementById("hudCanvas");
    const ctx = overlay.getContext("2d");
    if (overlay.width !== window.innerWidth || overlay.height !== window.innerHeight) {
        overlay.width = window.innerWidth;
        overlay.height = window.innerHeight;
    }
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    ctx.fillStyle = "white";
    ctx.font = "bold 32px monospace";
    ctx.textAlign = "left";
    ctx.fillText(`SCORE: ${score}`, 20, 40);
}

// ============================ Window Load & Resize ============================
window.onload = init;
window.onresize = () => {
    if (!gl) return;
    const canvas = document.getElementById("glCanvas");
    const overlay = document.getElementById("hudCanvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    overlay.width = window.innerWidth;
    overlay.height = window.innerHeight;
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
};

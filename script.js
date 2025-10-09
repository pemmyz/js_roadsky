// ============================ Utility Functions ============================
function toRadian(deg) {
  return deg * Math.PI / 180;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ============================ Shader Sources ============================
const vsSource = `
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
const fsSource = `
  precision mediump float;
  varying vec2 vTexCoord;
  uniform sampler2D uTexture;
  void main(void) {
      gl_FragColor = texture2D(uTexture, vTexCoord);
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
function loadTexture(gl, url) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const pixel = new Uint8Array([128, 128, 128, 255]); // Grey pixel
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const image = new Image();
  image.crossOrigin = "anonymous"; // Important for loading from other domains
  image.onload = function() {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  };
  image.src = url;
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
    let currentZ = 0;
    let currentX = 0;
    let currentY = 0;
    const platformHeight = 0.5;

    // CHANGE: Starting platform is now 5x longer (depth: 100)
    platforms.push({ x: 0, y: 0, z: 0, width: 10, depth: 100, height: platformHeight });
    // CHANGE: Update starting Z for the next platform to account for the longer start
    currentZ = 100;

    for (let i = 0; i < length; i++) {
        const gap = rng() * 5 + 3;
        currentZ += gap;
        const width = rng() * 8 + 4;
        const depth = rng() * 15 + 10;
        const xShift = (rng() - 0.5) * 10;
        currentX = Math.max(-15, Math.min(15, currentX + xShift));
        if (rng() < 0.2) {
            const yShift = (rng() - 0.5) * 3;
            currentY += yShift;
        }
        platforms.push({ x: currentX, y: currentY, z: currentZ, width, depth, height: platformHeight });
        currentZ += depth;
    }
    return platforms;
}

// ============================ Geometry Generation ============================
function createCubeGeometry(width, height, depth) {
    const w = width / 2, h = height / 2, d = depth / 2;
    return new Float32Array([
        // x, y, z, u, v
        -w,-h,d,0,0, w,-h,d,1,0, w,h,d,1,1, -w,-h,d,0,0, w,h,d,1,1, -w,h,d,0,1, // Front
        -w,-h,-d,1,0, -w,h,-d,1,1, w,h,-d,0,1, -w,-h,-d,1,0, w,h,-d,0,1, w,-h,-d,0,0, // Back
        -w,h,-d,0,1, -w,h,d,0,0, w,h,d,1,0, -w,h,-d,0,1, w,h,d,1,0, w,h,-d,1,1, // Top
        -w,-h,-d,0,0, w,-h,-d,1,0, w,-h,d,1,1, -w,-h,-d,0,0, w,-h,d,1,1, -w,h,d,0,1, // Bottom
        w,-h,-d,1,0, w,h,-d,1,1, w,h,d,0,1, w,-h,-d,1,0, w,h,d,0,1, w,-h,d,0,0, // Right
        -w,-h,-d,0,0, -w,-h,d,1,0, -w,h,d,1,1, -w,-h,-d,0,0, -w,h,d,1,1, -w,h,-d,0,1, // Left
    ]);
}

function buildTrackGeometry(platforms) {
    const allVerts = [];
    for (const p of platforms) {
        const cubeVerts = createCubeGeometry(p.width, p.height, p.depth);
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
let gl, shaderProgram;
let attribLocations, uniformLocations;
let buffers = {};
let textures = {};
let trackData, geometry;
let carPos, carVelocity, cameraTarget;
let score = 0;
let gameState = 'playing'; // Game state is now always 'playing'
let lastFrameTime = 0;
const keysDown = {};
const GRAVITY = 25.0, FORWARD_SPEED = 25.0, STRAFE_SPEED = 15.0, JUMP_STRENGTH = 10.0;

// CHANGE: Create a dedicated respawn function
function respawnPlayer() {
    console.log("Player fell, respawning...");
    vec3.set(carPos, 0, 2, 5); // Reset position to the start
    vec3.set(carVelocity, 0, 0, 0); // Reset velocity to zero
}

// This function now resets the entire track and score
function restartGame() {
    console.log("Restarting game with new track...");
    vec3.set(carPos, 0, 2, 5);
    vec3.set(carVelocity, 0, 0, 0);
    score = 0;
    trackData = createTrack(100, Date.now());
    geometry = buildTrackGeometry(trackData);
    initBuffers();
    lastFrameTime = performance.now();
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

  shaderProgram = initShaderProgram(gl, vsSource, fsSource);
  attribLocations = {
    aPosition: gl.getAttribLocation(shaderProgram, "aPosition"),
    aTexCoord: gl.getAttribLocation(shaderProgram, "aTexCoord")
  };
  uniformLocations = {
    uProjection: gl.getUniformLocation(shaderProgram, "uProjection"),
    uView: gl.getUniformLocation(shaderProgram, "uView"),
    uModel: gl.getUniformLocation(shaderProgram, "uModel"),
    uTexture: gl.getUniformLocation(shaderProgram, "uTexture")
  };
    
  textures.track = loadTexture(gl, "https://raw.githubusercontent.com/emilyxxie/emilyxxie.github.io/master/images/ground.jpg");
  textures.car = loadTexture(gl, "https://raw.githubusercontent.com/emilyxxie/emilyxxie.github.io/master/images/roof.jpg");

  trackData = createTrack(100, 12345); 
  geometry = buildTrackGeometry(trackData);
  initBuffers();
  
  gl.clearColor(0.20, 0.28, 0.34, 1.0);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  window.addEventListener("keydown", e => { keysDown[e.key.toLowerCase()] = true; });
  window.addEventListener("keyup",   e => { keysDown[e.key.toLowerCase()] = false; });
  
  lastFrameTime = performance.now();
  requestAnimationFrame(render);
}

function initBuffers() {
  if (buffers.track) gl.deleteBuffer(buffers.track.buffer);
  if (buffers.car) gl.deleteBuffer(buffers.car.buffer);
  buffers.track = initBuffer(geometry);
  buffers.car = initBuffer(createCubeGeometry(1.0, 0.6, 2.0)); 
}

function initBuffer(dataArray) {
  if (!dataArray || dataArray.length === 0) return { buffer: null, vertexCount: 0 };
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, dataArray, gl.STATIC_DRAW);
  return { buffer: buffer, vertexCount: dataArray.length / 5 };
}

// ============================ Render Loop ============================
function render(now) {
  const deltaTime = Math.min(0.1, (now - lastFrameTime) / 1000.0);
  lastFrameTime = now;
  
  // CHANGE: Game is always updating the car now, no 'gameover' state check
  updateCar(deltaTime);
  score = Math.max(score, Math.floor(carPos[2]));

  drawScene();
  updateHUD();
  requestAnimationFrame(render);
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
    
    // --- Sideways Movement ---
    let strafe = 0;
    if (keysDown['a'] || keysDown['arrowleft']) strafe = -1;
    else if (keysDown['d'] || keysDown['arrowright']) strafe = 1;

    // CHANGE: Jump is now only on Spacebar
    if (keysDown[' '] && onGround) {
        carVelocity[1] = JUMP_STRENGTH;
    }

    // CHANGE: Forward acceleration is now conditional on W / ArrowUp
    let forwardSpeed = 0;
    if (keysDown['w'] || keysDown['arrowup']) {
        forwardSpeed = FORWARD_SPEED;
    }
    
    carVelocity[0] = strafe * STRAFE_SPEED;
    carVelocity[2] = forwardSpeed; // Apply conditional speed

    if (!onGround) {
        carVelocity[1] -= GRAVITY * deltaTime;
    }

    vec3.scaleAndAdd(carPos, carPos, carVelocity, deltaTime);

    // CHANGE: Instead of Game Over, call respawnPlayer
    if (carPos[1] < -20) {
        respawnPlayer();
    }
}

function drawScene() {
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(shaderProgram);

    const projectionMatrix = mat4.create();
    mat4.perspective(projectionMatrix, toRadian(75), gl.canvas.width / gl.canvas.height, 0.1, 1000.0);
    gl.uniformMatrix4fv(uniformLocations.uProjection, false, projectionMatrix);

    const viewMatrix = mat4.create();
    const cameraOffset = vec3.fromValues(0, 5, -10);
    const cameraPos = vec3.create();
    vec3.add(cameraPos, carPos, cameraOffset);
    vec3.lerp(cameraTarget, cameraTarget, carPos, 0.1);
    mat4.lookAt(viewMatrix, cameraPos, cameraTarget, [0, 1, 0]);
    gl.uniformMatrix4fv(uniformLocations.uView, false, viewMatrix);

    const trackModelMatrix = mat4.create();
    drawObject(buffers.track, textures.track, trackModelMatrix);

    const carModelMatrix = mat4.create();
    mat4.translate(carModelMatrix, carModelMatrix, carPos);
    drawObject(buffers.car, textures.car, carModelMatrix);
}

function drawObject(bufferObj, texture, modelMatrix) {
    if (!bufferObj || !bufferObj.buffer || bufferObj.vertexCount === 0) return;
    
    const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
    const positionOffset = 0;
    const texCoordOffset = 3 * Float32Array.BYTES_PER_ELEMENT;

    gl.bindBuffer(gl.ARRAY_BUFFER, bufferObj.buffer);
    gl.vertexAttribPointer(attribLocations.aPosition, 3, gl.FLOAT, false, stride, positionOffset);
    gl.enableVertexAttribArray(attribLocations.aPosition);
    gl.vertexAttribPointer(attribLocations.aTexCoord, 2, gl.FLOAT, false, stride, texCoordOffset);
    gl.enableVertexAttribArray(attribLocations.aTexCoord);
    
    gl.uniformMatrix4fv(uniformLocations.uModel, false, modelMatrix);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniformLocations.uTexture, 0);
    
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

    // CHANGE: Updated instructions for new controls
    ctx.font = "16px monospace";
    ctx.fillText("A/D or Arrows: Steer", 20, overlay.height - 60);
    ctx.fillText("W or Up Arrow: Accelerate", 20, overlay.height - 40);
    ctx.fillText("Spacebar: Jump", 20, overlay.height - 20);

    // CHANGE: Removed the 'gameover' screen logic
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

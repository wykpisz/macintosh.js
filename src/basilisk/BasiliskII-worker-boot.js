const fs = require("fs");
const path = require("path");

const homeDir = require("os").homedir();
const macDir = path.join(homeDir, "macintosh.js");
const macintoshCopyPath = path.join(__dirname, "user_files");

function cleanupCopyPath() {
  try {
    if (fs.existsSync(macintoshCopyPath)) {
      fs.rmdirSync(macintoshCopyPath, { recursive: true });
    }

    fs.mkdirSync(macintoshCopyPath);
  } catch (error) {
    console.error(`cleanupCopyPath: Failed to remove`, error);
  }
}

function addAutoloader(module) {
  const copyFilesAtPath = function (sourcePath) {
    try {
      const absoluteSourcePath = path.join(macDir, sourcePath);
      const absoluteTargetPath = path.join(macintoshCopyPath, sourcePath);
      const targetPath = `/macintosh.js${sourcePath ? `/${sourcePath}` : '' }`;
      const files = fs.readdirSync(absoluteSourcePath);

      (files || []).forEach((fileName) => {
        try {
          // If not, let's move on
          const fileSourcePath = path.join(absoluteSourcePath, fileName);
          const copyPath = path.join(absoluteTargetPath, fileName);
          const relativeSourcePath = `${sourcePath ? `${sourcePath}/` : ''}${fileName}`;
          const fileUrl = `user_files/${relativeSourcePath}`

          // Check if directory
          if (fs.statSync(fileSourcePath).isDirectory()) {
            if (!fs.existsSync(copyPath)) {
              fs.mkdirSync(copyPath);
            }

            try {
              const virtualDirPath = `${targetPath}/${fileName}`;
              module.FS.mkdir(virtualDirPath);
            } catch (error) {
              console.log(error);
            }

            copyFilesAtPath(relativeSourcePath);
            return;
          }

          // We copy the files over and then add them as preload
          console.log(`loadDatafiles: Adding ${fileName}`);
          fs.copyFileSync(fileSourcePath, copyPath);

          module.FS_createPreloadedFile(
            targetPath,
            fileName,
            fileUrl,
            true,
            true
          );
        } catch (error) {
          postMessage("showMessageBoxSync", {
            type: 'error',
            title: 'Could not transfer file',
            message: `We tried to transfer ${fileName} to the virtual machine, but failed. The error was: ${error}`
          });

          console.error(`loadDatafiles: Failed to preload ${fileName}`, error);
        }
      });
    } catch (error) {
      postMessage("showMessageBoxSync", {
        type: 'error',
        title: 'Could not transfer files',
        message: `We tried to transfer files to the virtual machine, but failed. The error was: ${error}`
      });

      console.error(`loadDatafiles: Failed to copyFilesAtPath`, error);
    }
  }

  const loadDatafiles = function () {
    module.autoloadFiles.forEach((filepath) => {
      module.FS_createPreloadedFile(
        "/",
        path.basename(filepath),
        filepath,
        true,
        true
      );
    });

    // If the user has a macintosh.js dir, we'll copy over user
    // data
    if (!fs.existsSync(macDir)) {
      return;
    }

    copyFilesAtPath('');
  };

  if (module.autoloadFiles) {
    module.preRun = module.preRun || [];
    module.preRun.unshift(loadDatafiles);
  }

  return module;
}

function addCustomAsyncInit(module) {
  if (module.asyncInit) {
    module.preRun = module.preRun || [];
    module.preRun.push(function waitForCustomAsyncInit() {
      module.addRunDependency("__moduleAsyncInit");

      module.asyncInit(module, function asyncInitCallback() {
        module.removeRunDependency("__moduleAsyncInit");
      });
    });
  }
}

function writeSafely(filePath, fileData) {
  return new Promise((resolve) => {
    fs.writeFile(filePath, fileData, (error) => {
      if (error) {
        postMessage("showMessageBoxSync", {
          type: 'error',
          title: 'Could not save files',
          message: `We tried to save files from the virtual machine, but failed. The error was: ${error}`
        });

        console.error(`Disk save: Encountered error for ${filePath}`, error);
      } else {
        console.log(`Disk save: Finished writing ${filePath}`);
      }

      resolve();
    });
  });
}

async function saveFilesInPath(folderPath) {
  const entries = (Module.FS.readdir(folderPath) || []).filter(
    (v) => !v.startsWith(".")
  );

  if (!entries || entries.length === 0) return;

  // Ensure directory
  const targetDir = path.join(homeDir, folderPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir);
  }

  for (const file of entries) {
    try {
      const fileSourcePath = `${folderPath}/${file}`;
      const stat = Module.FS.analyzePath(fileSourcePath);

      if (stat && stat.object && stat.object.isFolder) {
        // This is a folder, step into
        await saveFilesInPath(fileSourcePath);
      } else if (stat && stat.object && stat.object.contents) {
        const fileData = stat.object.contents;
        const filePath = path.join(targetDir, file);

        await writeSafely(filePath, fileData);
      } else {
        console.log(
          `Disk save: Object at ${fileSourcePath} is something, but we don't know what`,
          stat
        );
      }
    } catch (error) {
      postMessage("showMessageBoxSync", {
        type: 'error',
        title: 'Could not safe file',
        message: `We tried to save the file "${file}" from the virtual machine, but failed. The error was: ${error}`
      });

      console.error(`Disk save: Could not write ${file}`, error);
    }
  }
}

let InputBufferAddresses = {
  globalLockAddr: 0,
  mouseMoveFlagAddr: 1,
  mouseMoveXDeltaAddr: 2,
  mouseMoveYDeltaAddr: 3,
  mouseButtonStateAddr: 4,
  keyEventFlagAddr: 5,
  keyCodeAddr: 6,
  keyStateAddr: 7,
};

let LockStates = {
  READY_FOR_UI_THREAD: 0,
  UI_THREAD_LOCK: 1,
  READY_FOR_EMUL_THREAD: 2,
  EMUL_THREAD_LOCK: 3,
};

var Module = null;

self.onmessage = async function (msg) {
  console.log("Worker message received", msg.data);

  // If it's a config object, start the show
  if (msg && msg.data && msg.data.SCREEN_WIDTH) {
    console.log("Start emulator worker");
    startEmulator(
      Object.assign({}, msg.data, { singleThreadedEmscripten: true })
    );
  }

  if (msg && msg.data === "disk_save") {
    const diskData = Module.FS.readFile("/disk");
    const diskPath = path.join(__dirname, "disk");

    // I wish we could do this with promises, but OOM crashes kill that idea
    try {
      console.log(`Trying to save disk`);
      fs.writeFileSync(diskPath, diskData);
      console.log(`Finished writing disk`);
    } catch (error) {
      console.error(`Failed to write disk`, error);
    }

    // Now, user files
    console.log(`Saving user files`);
    await saveFilesInPath("/macintosh.js");

    // Clean up old copy dir
    cleanupCopyPath();

    postMessage({ type: "disk_saved" });
  }
};

function startEmulator(parentConfig) {
  let screenBufferView = new Uint8Array(
    parentConfig.screenBuffer,
    0,
    parentConfig.screenBufferSize
  );

  let videoModeBufferView = new Int32Array(
    parentConfig.videoModeBuffer,
    0,
    parentConfig.videoModeBufferSize
  );

  let inputBufferView = new Int32Array(
    parentConfig.inputBuffer,
    0,
    parentConfig.inputBufferSize
  );

  let nextAudioChunkIndex = 0;
  let audioDataBufferView = new Uint8Array(
    parentConfig.audioDataBuffer,
    0,
    parentConfig.audioDataBufferSize
  );

  function waitForTwoStateLock(bufferView, lockIndex) {
    if (Atomics.load(bufferView, lockIndex) === LockStates.UI_THREAD_LOCK) {
      while (
        Atomics.compareExchange(
          bufferView,
          lockIndex,
          LockStates.UI_THREAD_LOCK,
          LockStates.EMUL_THREAD_LOCK
        ) !== LockStates.UI_THREAD_LOCK
      ) {
        // spin
        // TODO use wait and wake
      }
    } else {
      // already unlocked
    }
  }

  function releaseTwoStateLock(bufferView, lockIndex) {
    Atomics.store(bufferView, lockIndex, LockStates.UI_THREAD_LOCK); // unlock
  }

  function tryToAcquireCyclicalLock(bufferView, lockIndex) {
    let res = Atomics.compareExchange(
      bufferView,
      lockIndex,
      LockStates.READY_FOR_EMUL_THREAD,
      LockStates.EMUL_THREAD_LOCK
    );
    if (res === LockStates.READY_FOR_EMUL_THREAD) {
      return 1;
    }
    return 0;
  }

  function releaseCyclicalLock(bufferView, lockIndex) {
    Atomics.store(bufferView, lockIndex, LockStates.READY_FOR_UI_THREAD); // unlock
  }

  function acquireInputLock() {
    return tryToAcquireCyclicalLock(
      inputBufferView,
      InputBufferAddresses.globalLockAddr
    );
  }

  function releaseInputLock() {
    // reset
    inputBufferView[InputBufferAddresses.mouseMoveFlagAddr] = 0;
    inputBufferView[InputBufferAddresses.mouseMoveXDeltaAddr] = 0;
    inputBufferView[InputBufferAddresses.mouseMoveYDeltaAddr] = 0;
    inputBufferView[InputBufferAddresses.mouseButtonStateAddr] = 0;
    inputBufferView[InputBufferAddresses.keyEventFlagAddr] = 0;
    inputBufferView[InputBufferAddresses.keyCodeAddr] = 0;
    inputBufferView[InputBufferAddresses.keyStateAddr] = 0;

    releaseCyclicalLock(inputBufferView, InputBufferAddresses.globalLockAddr);
  }

  let AudioConfig = null;

  let AudioBufferQueue = [];

  Module = {
    autoloadFiles: ["disk", "rom", "prefs"],

    arguments: ["--config", "prefs"],
    canvas: null,

    blit: function blit(bufPtr, width, height, depth, usingPalette) {
      // console.time('await worker video lock');
      // waitForTwoStateLock(videoModeBufferView, 9);
      // console.timeEnd('await worker video lock');

      videoModeBufferView[0] = width;
      videoModeBufferView[1] = height;
      videoModeBufferView[2] = depth;
      videoModeBufferView[3] = usingPalette;
      let length = width * height * (depth === 32 ? 4 : 1); // 32bpp or 8bpp
      for (let i = 0; i < length; i++) {
        screenBufferView[i] = Module.HEAPU8[bufPtr + i];
      }
      // releaseTwoStateLock(videoModeBufferView, 9);
    },

    openAudio: function openAudio(
      sampleRate,
      sampleSize,
      channels,
      framesPerBuffer
    ) {
      AudioConfig = {
        sampleRate: sampleRate,
        sampleSize: sampleSize,
        channels: channels,
        framesPerBuffer: framesPerBuffer,
      };
      console.log(AudioConfig);
    },

    enqueueAudio: function enqueueAudio(bufPtr, nbytes, type) {
      let newAudio = Module.HEAPU8.slice(bufPtr, bufPtr + nbytes);
      // console.assert(
      //   nbytes == parentConfig.audioBlockBufferSize,
      //   `emulator wrote ${nbytes}, expected ${parentConfig.audioBlockBufferSize}`
      // );

      let writingChunkIndex = nextAudioChunkIndex;
      let writingChunkAddr =
        writingChunkIndex * parentConfig.audioBlockChunkSize;

      if (audioDataBufferView[writingChunkAddr] === LockStates.UI_THREAD_LOCK) {
        console.warn(
          "worker tried to write audio data to UI-thread-locked chunk",
          writingChunkIndex
        );
        return 0;
      }

      let nextNextChunkIndex = writingChunkIndex + 1;
      if (
        nextNextChunkIndex * parentConfig.audioBlockChunkSize >
        audioDataBufferView.length - 1
      ) {
        nextNextChunkIndex = 0;
      }

      audioDataBufferView[writingChunkAddr + 1] = nextNextChunkIndex;
      audioDataBufferView.set(newAudio, writingChunkAddr + 2);
      audioDataBufferView[writingChunkAddr] = LockStates.UI_THREAD_LOCK;

      nextAudioChunkIndex = nextNextChunkIndex;
      return nbytes;
    },

    debugPointer: function debugPointer(ptr) {
      console.log("debugPointer", ptr);
    },

    acquireInputLock: acquireInputLock,

    InputBufferAddresses: InputBufferAddresses,

    getInputValue: function getInputValue(addr) {
      return inputBufferView[addr];
    },

    totalDependencies: 0,
    monitorRunDependencies: function (left) {
      this.totalDependencies = Math.max(this.totalDependencies, left);

      if (left == 0) {
        postMessage({ type: "emulator_ready" });
      } else {
        postMessage({
          type: "emulator_loading",
          completion: (this.totalDependencies - left) / this.totalDependencies,
        });
      }
    },

    print: (message) => {
      console.log(message);

      postMessage({
        type: "TTY",
        data: message,
      });
    },

    printErr: console.warn.bind(console),

    releaseInputLock: releaseInputLock,
  };

  addAutoloader(Module);
  addCustomAsyncInit(Module);

  if (parentConfig.singleThreadedEmscripten) {
    importScripts("BasiliskII.js");
  }
}

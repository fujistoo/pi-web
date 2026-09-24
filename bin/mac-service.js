"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

const SERVICE_LABEL = "com.agegr.pi-web";
const WORKER_SERVICE_LABEL = "com.agegr.pi-web.agent-worker";
const OWNERSHIP_MARKER = "<!-- Managed by @agegr/pi-web. Do not edit. -->";

function assertSupportedPlatform(platform = process.platform) {
  if (platform !== "darwin") {
    throw new Error(
      `Pi Web service commands are only supported on macOS (darwin); plain pi-web foreground startup is available on ${platform}.`,
    );
  }
}

function getServicePaths(homeDir = os.homedir()) {
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const logDir = path.join(homeDir, "Library", "Logs", "Pi Web");
  return {
    launchAgentsDir,
    plistPath: path.join(launchAgentsDir, `${SERVICE_LABEL}.plist`),
    logDir,
    stdoutPath: path.join(logDir, "pi-web.log"),
    stderrPath: path.join(logDir, "pi-web.error.log"),
  };
}

function getWorkerServicePaths(homeDir = os.homedir()) {
  const paths = getServicePaths(homeDir);
  return {
    ...paths,
    plistPath: path.join(paths.launchAgentsDir, `${WORKER_SERVICE_LABEL}.plist`),
    stdoutPath: path.join(paths.logDir, "pi-web-agent-worker.log"),
    stderrPath: path.join(paths.logDir, "pi-web-agent-worker.error.log"),
  };
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]);
}

function serializePlist({
  label = SERVICE_LABEL,
  programArguments,
  workingDirectory,
  environmentVariables = {},
  stdoutPath,
  stderrPath,
  runAtLoad = true,
  keepAlive = true,
}) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    OWNERSHIP_MARKER,
    "<plist version=\"1.0\">",
    "<dict>",
    `  <key>Label</key>\n  <string>${xmlEscape(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArguments.map((argument) => `    <string>${xmlEscape(argument)}</string>`),
    "  </array>",
    `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(workingDirectory)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(environmentVariables)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, value]) => [
        `    <key>${xmlEscape(key)}</key>`,
        `    <string>${xmlEscape(value)}</string>`,
      ]),
    "  </dict>",
    "  <key>RunAtLoad</key>",
    `  <${runAtLoad ? "true" : "false"}/>`,
    "  <key>KeepAlive</key>",
    `  <${keepAlive ? "true" : "false"}/>`,
    `  <key>StandardOutPath</key>\n  <string>${xmlEscape(stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xmlEscape(stderrPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}

function createServicePlist({
  nodePath = process.execPath,
  scriptPath,
  packageDir,
  port,
  hostname,
  openBrowser,
  environment = process.env,
  paths = getServicePaths(),
}) {
  const programArguments = [
    nodePath,
    scriptPath,
    "--port",
    port,
    "--hostname",
    hostname,
  ];
  if (!openBrowser) programArguments.push("--no-open");

  return serializePlist({
    programArguments,
    workingDirectory: packageDir,
    environmentVariables: environment,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  });
}

function createWorkerServicePlist({
  nodePath = process.execPath,
  workerScriptPath,
  packageDir,
  environment = process.env,
  paths = getWorkerServicePaths(),
}) {
  return serializePlist({
    label: WORKER_SERVICE_LABEL,
    programArguments: [nodePath, workerScriptPath],
    workingDirectory: packageDir,
    environmentVariables: { ...environment, PI_WEB_PACKAGE_DIR: packageDir },
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    keepAlive: false,
  });
}

function isManagedPlist(contents, label = SERVICE_LABEL) {
  return contents.includes(OWNERSHIP_MARKER)
    && contents.includes(`<key>Label</key>\n  <string>${label}</string>`);
}

function readExistingPlist(plistPath, label = SERVICE_LABEL) {
  try {
    const contents = fs.readFileSync(plistPath, "utf8");
    if (!isManagedPlist(contents, label)) {
      throw new Error(
        `Refusing to overwrite ${plistPath}: it is not a Pi Web LaunchAgent.`,
      );
    }
    return contents;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writePlist(plistPath, contents, label = SERVICE_LABEL) {
  const existing = readExistingPlist(plistPath, label);
  if (existing === contents) return false;

  fs.mkdirSync(path.dirname(plistPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${plistPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, plistPath);
    fs.chmodSync(plistPath, 0o600);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`Could not write Pi Web LaunchAgent ${plistPath}: ${error.message}`);
  }
  return true;
}

function defaultLaunchctl(args, environment) {
  try {
    return {
      status: 0,
      stdout: execFileSync("launchctl", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      }),
    };
  } catch (error) {
    if (typeof error.status === "number") {
      return {
        status: error.status,
        stdout: error.stdout?.toString() ?? "",
        stderr: error.stderr?.toString() ?? "",
      };
    }
    throw new Error(`Could not run launchctl: ${error.message}`);
  }
}

function getServiceContext({ platform = process.platform, uid = process.getuid?.() } = {}) {
  assertSupportedPlatform(platform);
  if (!Number.isInteger(uid)) throw new Error("Could not determine the current macOS user id.");
  const domain = `gui/${uid}`;
  return { domain, serviceTarget: `${domain}/${SERVICE_LABEL}` };
}

function inspectService(runLaunchctl, serviceTarget) {
  const result = runLaunchctl(["print", serviceTarget]);
  if (result.status === 0) {
    return {
      loaded: true,
      running: /(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/.test(result.stdout),
    };
  }
  if (typeof result.status === "number") return { loaded: false, running: false };
  throw new Error("launchctl print returned no status.");
}

function requireLaunchctlSuccess(result, args) {
  if (result.status === 0) return;
  const detail = result.stderr?.trim() || result.stdout?.trim();
  throw new Error(
    `launchctl ${args.join(" ")} failed${detail ? `: ${detail}` : ` (exit code ${result.status})`}.`,
  );
}

function makeOptions(options = {}) {
  const paths = options.paths ?? getServicePaths(options.homeDir);
  const workerPaths = options.workerPaths ?? getWorkerServicePaths(options.homeDir);
  const context = getServiceContext(options);
  const runLaunchctl = options.runLaunchctl
    ?? ((args) => defaultLaunchctl(args, options.environment ?? process.env));
  return {
    ...options,
    paths,
    workerPaths,
    ...context,
    workerServiceTarget: `${context.domain}/${WORKER_SERVICE_LABEL}`,
    runLaunchctl,
  };
}

function ensureWorkerService(service) {
  fs.mkdirSync(service.workerPaths.logDir, { recursive: true, mode: 0o700 });
  const workerScriptPath = service.workerScriptPath
    ?? path.join(service.packageDir, "bin", "pi-web-agent-worker.js");
  const plist = createWorkerServicePlist({
    ...service,
    workerScriptPath,
    paths: service.workerPaths,
  });
  const changed = writePlist(service.workerPaths.plistPath, plist, WORKER_SERVICE_LABEL);
  let state = inspectService(service.runLaunchctl, service.workerServiceTarget);
  if (state.loaded && changed && !state.running) {
    const args = ["bootout", service.workerServiceTarget];
    requireLaunchctlSuccess(service.runLaunchctl(args), args);
    state = { loaded: false, running: false };
  }
  if (!state.loaded) {
    const args = ["bootstrap", service.domain, service.workerPaths.plistPath];
    requireLaunchctlSuccess(service.runLaunchctl(args), args);
    return { loaded: true, running: true };
  }
  if (!state.running) {
    const args = ["kickstart", "-k", service.workerServiceTarget];
    requireLaunchctlSuccess(service.runLaunchctl(args), args);
    return { loaded: true, running: true };
  }
  return state;
}

function startService(options) {
  const service = makeOptions(options);
  ensureWorkerService(service);
  fs.mkdirSync(service.paths.logDir, { recursive: true, mode: 0o700 });
  const plist = createServicePlist({ ...options, paths: service.paths });
  const changed = writePlist(service.paths.plistPath, plist);
  const state = inspectService(service.runLaunchctl, service.serviceTarget);

  if (state.loaded && !changed && state.running) {
    return { message: "Pi Web service is already running.", paths: service.paths };
  }
  if (state.loaded && changed) {
    const args = ["bootout", service.serviceTarget];
    requireLaunchctlSuccess(service.runLaunchctl(args), args);
  }

  const action = state.loaded && !changed ? "kickstart" : "bootstrap";
  const args = action === "kickstart"
    ? ["kickstart", "-k", service.serviceTarget]
    : ["bootstrap", service.domain, service.paths.plistPath];
  requireLaunchctlSuccess(service.runLaunchctl(args), args);
  return { message: "Pi Web service started.", paths: service.paths };
}

function stopService(options) {
  const service = makeOptions(options);
  if (fs.existsSync(service.paths.plistPath)) readExistingPlist(service.paths.plistPath);
  if (fs.existsSync(service.workerPaths.plistPath)) {
    readExistingPlist(service.workerPaths.plistPath, WORKER_SERVICE_LABEL);
  }
  const workerState = inspectService(service.runLaunchctl, service.workerServiceTarget);
  if (workerState.loaded) {
    const args = ["bootout", service.workerServiceTarget];
    requireLaunchctlSuccess(service.runLaunchctl(args), args);
  }
  const state = inspectService(service.runLaunchctl, service.serviceTarget);
  if (state.loaded) {
    const args = ["bootout", service.serviceTarget];
    requireLaunchctlSuccess(service.runLaunchctl(args), args);
  }
  if (!state.loaded && !workerState.loaded) {
    return { message: "Pi Web service is not running.", paths: service.paths };
  }
  return { message: "Pi Web service stopped.", paths: service.paths };
}

function restartService(options) {
  const service = makeOptions(options);
  if (fs.existsSync(service.paths.plistPath)) readExistingPlist(service.paths.plistPath);
  const state = inspectService(service.runLaunchctl, service.serviceTarget);
  if (state.loaded) {
    const args = ["bootout", service.serviceTarget];
    requireLaunchctlSuccess(service.runLaunchctl(args), args);
  }
  // Deliberately leave the worker LaunchAgent alone: restart is safe for an
  // active task. Explicit `stop` is the destructive lifecycle operation.
  return startService(options);
}

function reloadService(options = {}) {
  const service = makeOptions(options);
  if (fs.existsSync(service.paths.plistPath)) readExistingPlist(service.paths.plistPath);
  const state = inspectService(service.runLaunchctl, service.serviceTarget);
  if (!state.loaded) throw new Error("Pi Web service is not loaded. Run `pi-web start` first.");
  const args = ["kickstart", "-k", service.serviceTarget];
  requireLaunchctlSuccess(service.runLaunchctl(args), args);
  return { message: "Pi Web service reloaded.", paths: service.paths };
}

function statusService(options) {
  const service = makeOptions(options);
  if (fs.existsSync(service.paths.plistPath)) readExistingPlist(service.paths.plistPath);
  if (fs.existsSync(service.workerPaths.plistPath)) {
    readExistingPlist(service.workerPaths.plistPath, WORKER_SERVICE_LABEL);
  }
  const state = inspectService(service.runLaunchctl, service.serviceTarget);
  const worker = inspectService(service.runLaunchctl, service.workerServiceTarget);
  const status = state.running
    ? "running"
    : state.loaded
      ? "not running (loaded but inactive)"
      : "not running (not loaded)";
  const workerStatus = worker.running
    ? "running"
    : worker.loaded
      ? "not running (loaded but inactive)"
      : "not running (not loaded)";
  return {
    message: `Pi Web service: ${status}\nAgent worker: ${workerStatus}\nLaunchAgent: ${service.paths.plistPath}\nWorker LaunchAgent: ${service.workerPaths.plistPath}\nLogs: ${service.paths.logDir}`,
    paths: service.paths,
    workerPaths: service.workerPaths,
    worker,
    ...state,
  };
}

function runServiceCommand(command, options) {
  if (command === "start") return startService(options);
  if (command === "stop") return stopService(options);
  if (command === "status") return statusService(options);
  if (command === "restart") return restartService(options);
  if (command === "reload") return reloadService(options);
  throw new Error(`Unknown Pi Web service command: ${command}`);
}

module.exports = {
  OWNERSHIP_MARKER,
  SERVICE_LABEL,
  WORKER_SERVICE_LABEL,
  assertSupportedPlatform,
  createServicePlist,
  createWorkerServicePlist,
  getServicePaths,
  getWorkerServicePaths,
  isManagedPlist,
  reloadService,
  restartService,
  runServiceCommand,
  startService,
  statusService,
  stopService,
  serializePlist,
};

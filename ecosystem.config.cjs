module.exports = {
  apps: [{
    name: "Lanou",
    script: "server/index.js",
    cwd: "D:/local-llm-ui",
    autorestart: true,
    max_memory_restart: "2G"
  }]
}
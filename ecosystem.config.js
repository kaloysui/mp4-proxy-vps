module.exports = {
  apps: [{
    name: 'mp4-proxy',
    script: 'server.js',
    env: { PORT: 8080 },
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '64M',
  }],
};
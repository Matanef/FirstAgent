// server/tools/systemMonitor.js
// Provides the agent with real-time awareness of the host machine's hardware and load.

import os from "os";

export async function systemMonitor(request) {
  // 1. Defensive Input Parsing
  const text = typeof request === "string" ? request : (request?.text || request?.input || "");
  
  try {
    // 2. Gather System Metrics
    const totalMemGB = (os.totalmem() / (1024 ** 3)).toFixed(2);
    const freeMemGB = (os.freemem() / (1024 ** 3)).toFixed(2);
    const usedMemGB = (totalMemGB - freeMemGB).toFixed(2);
    const memUsagePercent = Math.round((usedMemGB / totalMemGB) * 100);
    
    const cpus = os.cpus();
    const coreCount = cpus.length;
    const cpuModel = cpus[0]?.model || "Unknown CPU";
    
    const uptimeHours = (os.uptime() / 3600).toFixed(2);
    const platform = `${os.type()} ${os.release()} (${os.arch()})`;

    // 3. Format Output
    let report = `🖥️ **System Status Report**\n\n`;
    report += `**OS:** ${platform}\n`;
    report += `**Uptime:** ${uptimeHours} hours\n`;
    report += `**CPU:** ${cpuModel} (${coreCount} cores)\n`;
    report += `**Memory:** ${usedMemGB} GB / ${totalMemGB} GB (${memUsagePercent}% used)\n`;
    
    // Add a quick health assessment
    if (memUsagePercent > 90) {
      report += `\n⚠️ **WARNING:** Memory usage is critical. Consider freeing up resources before running heavy LLM tasks.`;
    } else {
      report += `\n✅ System resources look healthy and ready for tasks.`;
    }

    // 4. Return Success
    return {
      tool: "systemMonitor",
      success: true,
      final: true,
      data: {
        text: report,
        preformatted: true
      }
    };

  } catch (error) {
    // 5. Graceful Error Handling
    return {
      tool: "systemMonitor",
      success: false,
      final: true,
      error: `Action failed: Could not read system metrics - ${error.message}`
    };
  }
}
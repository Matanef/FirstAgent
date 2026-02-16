// src/components/FundamentalsChart.jsx
import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";

export default function FundamentalsChart({ charts }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!charts || !charts.data) return;

    const ctx = canvasRef.current.getContext("2d");

    const { labels, series } = charts.data;

    // Build datasets for PE and EPS
    const datasets = [];

    Object.keys(series.pe).forEach(ticker => {
      datasets.push({
        label: `${ticker} PE`,
        data: series.pe[ticker],
        borderColor: "#4e79a7",
        backgroundColor: "rgba(78,121,167,0.3)",
        tension: 0.3
      });
    });

    Object.keys(series.eps).forEach(ticker => {
      datasets.push({
        label: `${ticker} EPS`,
        data: series.eps[ticker],
        borderColor: "#f28e2b",
        backgroundColor: "rgba(242,142,43,0.3)",
        tension: 0.3
      });
    });

    const chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            labels: { color: "#fff" }
          }
        },
        scales: {
          x: { ticks: { color: "#ccc" } },
          y: { ticks: { color: "#ccc" } }
        }
      }
    });

    return () => chart.destroy();
  }, [charts]);

  return (
    <div className="chart-container">
      <canvas ref={canvasRef} />
    </div>
  );
}
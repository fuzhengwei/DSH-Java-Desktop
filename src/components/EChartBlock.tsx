import { useEffect, useRef } from "react";

/**
 * ECharts 渲染块：对话 markdown 中 ```echarts 代码块（JSON option）渲染为图表。
 * 动态加载 echarts，失败时降级显示原始 JSON。
 */
export const EChartBlock = function EChartBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let chart: { dispose: () => void } | null = null;
    void (async () => {
      try {
        const echarts = await import("echarts");
        const option = JSON.parse(code);
        if (disposed || !containerRef.current) return;
        const instance = echarts.init(containerRef.current);
        instance.setOption(option);
        chart = instance;
      } catch {
        // JSON 解析失败或渲染错误：容器显示原始代码（外层已兜底展示）
        if (containerRef.current) {
          containerRef.current.dataset.failed = "1";
        }
      }
    })();
    return () => {
      disposed = true;
      chart?.dispose();
    };
  }, [code]);

  return (
    <div className="echart-block">
      <div ref={containerRef} className="echart-canvas" />
      <details className="echart-source">
        <summary>查看图表配置</summary>
        <pre>{code}</pre>
      </details>
    </div>
  );
};

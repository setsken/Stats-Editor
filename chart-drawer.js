// Chart drawing code that runs in page context
(function() {
  // Debug flag - set to false in production to disable all console logs
  const DEBUG = false;
  function log(...args) { if (DEBUG) log(...args); }
  function logError(...args) { if (DEBUG) logError(...args); }
  
  // Check authentication before running
  const authStatus = localStorage.getItem('ofStatsAuthStatus');
  if (authStatus !== 'authenticated') {
    log('OF Stats: User not authenticated, chart drawer disabled');
    return;
  }
  
  // Listen for chart draw requests from extension
  window.addEventListener('of-stats-draw-chart', function(event) {
    var config = event.detail;
    
    log('OF Stats: Drawing chart with config:', config);
    
    var canvas = document.getElementById(config.canvasId);
    if (!canvas) {
      log('OF Stats: Canvas not found:', config.canvasId);
      return;
    }
    
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      log('OF Stats: Could not get canvas context');
      return;
    }
    
    if (typeof Chart === 'undefined') {
      log('OF Stats: Chart.js not available');
      return;
    }
    
    // Destroy existing chart if any
    var existingChart = Chart.getChart(canvas);
    if (existingChart) {
      existingChart.destroy();
    }
    
    // Make colors more transparent like original, except blue which stays solid
    var datasets = config.datasets.map(function(ds) {
      var color = ds.borderColor;
      
      // Blue line (#2196f3) stays solid, others transparent
      if (color === '#2196f3') {
        return {
          data: ds.data,
          borderColor: color,
          borderWidth: 2.2,
          tension: 0.35,
          pointRadius: 0,
          fill: false
        };
      }
      
      // Convert hex to rgba with transparency for other colors
      var alpha = 0.6;
      var r = parseInt(color.slice(1, 3), 16);
      var g = parseInt(color.slice(3, 5), 16);
      var b = parseInt(color.slice(5, 7), 16);
      var rgbaColor = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
      
      return {
        data: ds.data,
        borderColor: rgbaColor,
        borderWidth: 1.7,
        tension: 0.35,
        pointRadius: 0,
        fill: false
      };
    });
    
    // Plugin to draw date labels with right offset (like b-chart__double-line__aside)
    var dateOffsetPlugin = {
      id: 'dateOffsetPlugin',
      afterDraw: function(chart) {
        var ctx = chart.ctx;
        var chartArea = chart.chartArea;
        var xScale = chart.scales.x;
        var labels = chart.data.labels;
        
        if (!xScale || !labels || labels.length === 0) return;
        
        ctx.save();
        
        // Date label styling (matching original)
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#333333';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        
        // Draw labels with right offset
        var rightOffset = 5; // Offset to the right of data point position
        
        labels.forEach(function(label, index) {
          // Get X position for this data point
          var x = xScale.getPixelForValue(index) + rightOffset;
          var y = chartArea.bottom + 18;
          
          ctx.fillText(label, x, y);
        });
        
        ctx.restore();
        
        log('OF Stats: Drew', labels.length, 'date labels with offset');
      }
    };
    
    // Create chart exactly like original OnlyFans
    var chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: config.labels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 800,
          easing: 'easeOutQuart'
        },
        
        layout: {
          padding: {
            left: 0,
            right: 0,
            bottom: 0,
            top: 0
          }
        },
        
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        },
        
        scales: {
          x: {
            offset: false,
            grid: { 
              display: false,
              offset: false
            },
            border: { display: false },
            ticks: {
              display: false, // Hide default ticks - we draw our own with offset
              color: '#333333',
              autoSkip: false,
              maxRotation: 0,
              padding: 8,
              font: { size: 11 }
            }
          },
          y: {
            grid: { 
              color: '#eef2f7',
              drawBorder: false
            },
            border: { display: false },
            ticks: { 
              display: false,
              minTicksLimit: 4,
              maxTicksLimit: 4,
            },
            beginAtZero: true,
            grace: '5%'
          }
        }
      },
      plugins: [dateOffsetPlugin]
    });
    
    // Store chart instance on canvas for cleanup
    canvas._chartInstance = chartInstance;
    
    log('OF Stats: Chart.js chart created successfully!');
  });
  
  // Listen for statistics page chart drawing
  window.addEventListener('of-stats-draw-statistics-charts', function(event) {
    var data = event.detail;
    if (!data) return;
    
    log('OF Stats: Drawing statistics charts');
    
    // Function to actually draw the charts
    function drawStatisticsCharts() {
      var mainCanvas = document.getElementById('of-stats-earnings-chart-main');
      var asideCanvas = document.getElementById('of-stats-earnings-chart-aside');
      var tooltipEl = document.getElementById('of-stats-chart-tooltip');
      
      if (!mainCanvas || !asideCanvas) {
        log('OF Stats: Statistics canvases not found, will retry...');
        return false;
      }
      
      if (typeof Chart === 'undefined') {
        log('OF Stats: Chart.js not available for statistics');
        return false;
      }
    
    var labels = data.labels;
    var earningsData = data.earnings;
    var countData = data.counts;
    var startDate = data.startDate ? new Date(data.startDate) : new Date();
    
    // Destroy existing charts
    var existingMain = Chart.getChart(mainCanvas);
    if (existingMain) existingMain.destroy();
    var existingAside = Chart.getChart(asideCanvas);
    if (existingAside) existingAside.destroy();
    
    // Calculate max values for Y axes
    var maxEarnings = Math.max.apply(null, earningsData);
    var maxCount = Math.max.apply(null, countData);
    
    // Round up to nice step values for main chart (need 4 lines: 0, step, step*2, step*3)
    // So max = step * 3, and we show 3 numbers (step, step*2, step*3)
    var earningsStep, earningsMax;
    if (maxEarnings <= 150) {
      earningsStep = 50;
      earningsMax = 150;
    } else if (maxEarnings <= 300) {
      earningsStep = 100;
      earningsMax = 300;
    } else if (maxEarnings <= 600) {
      earningsStep = 200;
      earningsMax = 600;
    } else if (maxEarnings <= 900) {
      earningsStep = 300;
      earningsMax = 900;
    } else {
      earningsStep = Math.ceil(maxEarnings / 3 / 100) * 100;
      earningsMax = earningsStep * 3;
    }
    
    // Aside chart: 3 lines (0, 10, 20), 2 numbers (10, 20)
    var countStep = 10;
    var countMax = Math.max(20, Math.ceil(maxCount / 10) * 10);
    
    // Tooltip handler (defined before commonOptions since it's referenced there)
    var lastTooltipIndex = -1;
    
    function externalTooltipHandler(context) {
      var chart = context.chart;
      var tooltip = context.tooltip;
      
      if (!tooltipEl) return;
      
      if (tooltip.opacity === 0) {
        if (tooltipEl.style.opacity !== '0') tooltipEl.style.opacity = 0;
        lastTooltipIndex = -1;
        return;
      }
      
      if (tooltip.dataPoints && tooltip.dataPoints.length > 0) {
        var index = tooltip.dataPoints[0].dataIndex;
        
        if (lastTooltipIndex !== -1 && lastTooltipIndex !== index) {
          tooltipEl.style.opacity = 0;
        }
        lastTooltipIndex = index;
        
        // Update tooltip content
        var d = new Date(startDate);
        d.setDate(startDate.getDate() + index);
        var titleText = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        
        var titleEl = tooltipEl.querySelector('.b-chart__tooltip__title');
        if (titleEl) titleEl.innerText = titleText;
        
        var valEls = tooltipEl.querySelectorAll('.b-chart__tooltip__text__value');
        if (valEls[0]) valEls[0].innerText = '$' + earningsData[index].toFixed(2);
        if (valEls[1]) valEls[1].innerText = countData[index];
      }
      
      var canvasRect = chart.canvas.getBoundingClientRect();
      var containerRect = chart.canvas.parentElement.parentElement.getBoundingClientRect();
      
      var positionX = canvasRect.left - containerRect.left;
      var positionY = canvasRect.top - containerRect.top;
      
      tooltipEl.style.opacity = 1;
      
      var tooltipWidth = tooltipEl.offsetWidth || 160;
      var tooltipHeight = tooltipEl.offsetHeight || 80;
      var chartWidth = chart.width;
      var caretX = tooltip.caretX;
      var caretY = tooltip.caretY;
      
      var left = positionX + caretX + 15;
      if (caretX + tooltipWidth + 15 > chartWidth) {
        left = positionX + caretX - tooltipWidth - 15;
      }
      
      var top = positionY + caretY - (tooltipHeight / 2);
      
      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
    }
    
    // Shared chart options
    var commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          left: 0,
          right: 60, // Space for numbers column
          top: 0,
          bottom: 0
        }
      },
      interaction: {
        mode: 'index',
        intersect: true
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: false,
          external: externalTooltipHandler
        }
      },
      elements: {
        point: {
          radius: 0,
          hoverRadius: 4,
          hoverBorderWidth: 2,

          hitRadius: 15
        },
        line: {
          tension: 0,
          borderWidth: 2
        }
      }
    };
    
    // Plugin to draw grid lines and labels manually
    var drawGridPlugin = {
      id: 'drawGridPlugin',
      beforeDraw: function(chart) {
        var ctx = chart.ctx;
        var chartArea = chart.chartArea;
        var yScale = chart.scales.y;
        var xScale = chart.scales.x;
        var rightEdge = chart.width;
        
        // Determine chart type by canvas id
        var isMainChart = chart.canvas.id === 'of-stats-earnings-chart-main';
        var isAsideChart = chart.canvas.id === 'of-stats-earnings-chart-aside';
        
        // Grid colors - light for inside chart, solid for horizontal separators
        var gridColorLight = 'rgba(224, 224, 224, 0.3)';
        var gridColorSolid = 'rgba(224, 224, 224, 0.3)';
        var gridColorHorizontal = '#cdd3d9'; // For horizontal lines under charts (more visible)
        
        ctx.save();
        
        // Draw vertical separator line at right edge of chart area
        ctx.beginPath();
        ctx.moveTo(chartArea.right, chartArea.top);
        ctx.lineTo(chartArea.right, chartArea.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = gridColorLight;
        ctx.stroke();
        
        // Draw horizontal line at bottom of chart area
        // For aside chart - thinner and solid, for main chart - normal
        ctx.beginPath();
        ctx.moveTo(chartArea.left, chartArea.bottom);
        ctx.lineTo(rightEdge, chartArea.bottom);
        if (isAsideChart) {
          ctx.lineWidth = 0.5;
          ctx.strokeStyle = gridColorHorizontal;
        } else {
          ctx.lineWidth = 1;
          ctx.strokeStyle = gridColorHorizontal;
        }
        ctx.stroke();
        
        // Get grid line positions from X scale
        var gridLines = xScale._gridLineItems;
        
        // For main chart: draw separator line below with vertical grid marks
        if (isMainChart && gridLines && gridLines.length > 0) {
          // Draw horizontal separator line below chart (solid, more visible, thin)
          ctx.beginPath();
          ctx.moveTo(chartArea.left, chartArea.bottom + 8);
          ctx.lineTo(rightEdge, chartArea.bottom + 8);
          ctx.lineWidth = 0.5;
          ctx.strokeStyle = gridColorHorizontal;
          ctx.stroke();
          
          // Draw vertical lines at grid positions with offset -90
          gridLines.forEach(function(line) {
            var lineX = line.x1 - 90;
            
            // Vertical line in chart area (light)
            ctx.beginPath();
            ctx.moveTo(lineX, chartArea.top);
            ctx.lineTo(lineX, chartArea.bottom);
            ctx.lineWidth = 1;
            ctx.strokeStyle = gridColorLight;
            ctx.stroke();
            
            // Short line below chart (solid)
            ctx.beginPath();
            ctx.moveTo(lineX, chartArea.bottom + 2);
            ctx.lineTo(lineX, chartArea.bottom + 33);
            ctx.lineWidth = 1;
            ctx.strokeStyle = gridColorSolid;
            ctx.stroke();
          });
          
          // Draw 5th line at chartArea.right (light for chart, solid below)
          ctx.beginPath();
          ctx.moveTo(chartArea.right, chartArea.top);
          ctx.lineTo(chartArea.right, chartArea.bottom);
          ctx.lineWidth = 1;
          ctx.strokeStyle = gridColorLight;
          ctx.stroke();
          
          ctx.beginPath();
          ctx.moveTo(chartArea.right, chartArea.bottom + 2);
          ctx.lineTo(chartArea.right, chartArea.bottom + 30);
          ctx.lineWidth = 1;
          ctx.strokeStyle = gridColorSolid;
          ctx.stroke();
        }
        
        // For aside chart: draw vertical lines and date labels
        if (isAsideChart && gridLines && gridLines.length > 0) {
          // Draw vertical lines at grid positions with offset -90
          gridLines.forEach(function(line) {
            var lineX = line.x1 - 90;
            
            // Vertical line in chart area (light)
            ctx.beginPath();
            ctx.moveTo(lineX, chartArea.top);
            ctx.lineTo(lineX, chartArea.bottom);
            ctx.lineWidth = 1;
            ctx.strokeStyle = gridColorLight;
            ctx.stroke();
            
            // Short line below chart (solid)
            ctx.beginPath();
            ctx.moveTo(lineX, chartArea.bottom + 2);
            ctx.lineTo(lineX, chartArea.bottom + 33);
            ctx.lineWidth = 1;
            ctx.strokeStyle = gridColorSolid;
            ctx.stroke();
          });
          
          // 5th line at chartArea.right
          ctx.beginPath();
          ctx.moveTo(chartArea.right, chartArea.top);
          ctx.lineTo(chartArea.right, chartArea.bottom);
          ctx.lineWidth = 1;
          ctx.strokeStyle = gridColorLight;
          ctx.stroke();
          
          ctx.beginPath();
          ctx.moveTo(chartArea.right, chartArea.bottom + 2);
          ctx.lineTo(chartArea.right, chartArea.bottom + 30);
          ctx.lineWidth = 1;
          ctx.strokeStyle = gridColorSolid;
          ctx.stroke();
          
          // Draw date labels
          ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#000';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          
          var dateIndices = [1, 8, 15, 22, 29];
          
          dateIndices.forEach(function(dateIndex, gridIndex) {
            if (gridIndex >= 4) return;
            
            if (gridLines[gridIndex]) {
              var gridLineX = gridLines[gridIndex].x1;
              // Vertical lines are at gridLineX - 90
              // Dates should be positioned to the RIGHT of vertical lines
              // So we use gridLineX - 90 (line position) + some offset to place text after line
              var verticalLineX = gridLineX + 33;
              var x = verticalLineX + 5; // 5px after the vertical line
              
              if (x < chartArea.left) {
                x = chartArea.left + 5;
              }
              
              var d = new Date(startDate);
              d.setDate(startDate.getDate() + dateIndex);
              var line1 = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ',';
              var line2 = d.getFullYear().toString();
              
              ctx.fillText(line1, x, chartArea.bottom + 6);
              ctx.fillText(line2, x, chartArea.bottom + 18);
            }
          });
          
          // Draw 5th date at the end (right after chartArea.right vertical line)
          var d5 = new Date(startDate);
          d5.setDate(startDate.getDate() + 29);
          var line1_5th = d5.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ',';
          var line2_5th = d5.getFullYear().toString();
          var x5 = chartArea.right + 5;
          
          ctx.fillText(line1_5th, x5, chartArea.bottom + 6);
          ctx.fillText(line2_5th, x5, chartArea.bottom + 18);
        }
        
        // Draw horizontal grid lines and Y-axis labels
        if (yScale && yScale.ticks) {
          ctx.font = '450 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#000';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          
          yScale.ticks.forEach(function(tick) {
            var y = yScale.getPixelForValue(tick.value);
            
            // Draw extended grid line from chart right to canvas edge (light)
            ctx.beginPath();
            ctx.moveTo(chartArea.right, y);
            ctx.lineTo(rightEdge, y);
            ctx.lineWidth = 1;
            ctx.strokeStyle = gridColorLight;
            ctx.stroke();
            
            // Draw tick label (skip 0)
            if (tick.value !== 0) {
              var label = tick.value;
              if (isMainChart) {
                label = '$' + tick.value;
              }
              // Offset y by +10 to position label below the line (inside the cell)
              ctx.fillText(label, rightEdge - 2, y + 10);
            }
          });
        }
        
        ctx.restore();
      }
    };
    
    // Main Chart (Earnings - blue)
    var chartMain = new Chart(mainCanvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Earnings',
          data: earningsData,
          borderColor: '#00aff0',
          backgroundColor: 'rgba(41, 182, 246, 0.1)',
          fill: true,
          pointHoverBackgroundColor: '#00aff0',
          pointHoverBorderColor: '#fff',
          clip: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: {
            left: 0,
            right: 60,
            top: 0,
            bottom: 8
          }
        },
        interaction: commonOptions.interaction,
        plugins: commonOptions.plugins,
        elements: commonOptions.elements,
        scales: {
          x: {
            display: true,
            offset: false,
            bounds: 'data',
            grid: {
              display: false,
              drawBorder: false,
              drawOnChartArea: false,
              drawTicks: false
            },
            ticks: {
              display: false,
              callback: function(val, index) {
                return (index % 7 === 0) ? '' : null;
              }
            }
          },
          y: {
            position: 'right',
            min: 0,
            max: earningsMax,
            border: { display: false },
            grid: {
              color: 'rgba(224, 224, 224, 0.3)',
              drawBorder: false,
              drawTicks: false
            },
            ticks: {
              display: false,
              stepSize: earningsStep,
              autoSkip: false,
              maxTicksLimit: 4,
              callback: function(value) {
                if (value === 0) return '';
                return '$' + value;
              }
            }
          }
        }
      },
      plugins: [drawGridPlugin]
    });
    
    // Aside Chart (Transactions - gray)
    var chartAside = new Chart(asideCanvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Transactions',
          data: countData,
          borderColor: '#8a96a3',
          backgroundColor: 'rgba(144, 164, 174, 0.15)',
          fill: true,
          pointHoverBackgroundColor: '#8a96a3',
          pointHoverBorderColor: '#fff',
          clip: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: {
            left: 0,
            right: 60,
            top: 8,
            bottom: 45
          }
        },
        interaction: commonOptions.interaction,
        plugins: commonOptions.plugins,
        elements: commonOptions.elements,
        scales: {
          x: {
            display: true,
            offset: false,
            grid: {
              display: false,
              drawBorder: false,
              drawOnChartArea: false,
              drawTicks: false
            },
            ticks: {
              display: false,
              callback: function(val, index) {
                return (index % 7 === 0) ? '' : null;
              }
            }
          },
          y: {
            position: 'right',
            min: 0,
            max: countMax,
            border: { display: false },
            grid: {
              color: 'rgba(224, 224, 224, 0.3)',
              drawBorder: false,
              drawTicks: false
            },
            ticks: {
              display: false,
              stepSize: countStep,
              autoSkip: false,
              maxTicksLimit: 3,
              callback: function(value) {
                if (value === 0 || value > countMax) return '';
                return value;
              }
            }
          }
        }
      },
      plugins: [drawGridPlugin]
    });
    
    // Sync hover between charts
    var lastHoveredIndex = -1;
    
    function syncChartHover(sourceChart, targetChart, index) {
      if (index !== lastHoveredIndex) {
        lastHoveredIndex = index;
        if (index >= 0) {
          targetChart.setActiveElements([{ datasetIndex: 0, index: index }]);
        } else {
          targetChart.setActiveElements([]);
        }
        targetChart.render();
      }
    }
    
    mainCanvas.addEventListener('mousemove', function(e) {
      var points = chartMain.getElementsAtEventForMode(e, 'index', { intersect: true }, false);
      if (points.length > 0) {
        syncChartHover(chartMain, chartAside, points[0].index);
      } else {
        if (lastHoveredIndex !== -1) {
          lastHoveredIndex = -1;
          chartAside.setActiveElements([]);
          chartAside.render();
        }
      }
    });
    
    mainCanvas.addEventListener('mouseleave', function() {
      lastHoveredIndex = -1;
      chartAside.setActiveElements([]);
      chartAside.render();
    });
    
    asideCanvas.addEventListener('mousemove', function(e) {
      var points = chartAside.getElementsAtEventForMode(e, 'index', { intersect: true }, false);
      if (points.length > 0) {
        syncChartHover(chartAside, chartMain, points[0].index);
      } else {
        if (lastHoveredIndex !== -1) {
          lastHoveredIndex = -1;
          chartMain.setActiveElements([]);
          chartMain.render();
        }
      }
    });
    
    asideCanvas.addEventListener('mouseleave', function() {
      lastHoveredIndex = -1;
      chartMain.setActiveElements([]);
      chartMain.render();
    });
    
    log('OF Stats: Statistics charts rendered');
      return true; // Success
    }
    
    // Try to draw immediately
    if (!drawStatisticsCharts()) {
      // If failed, retry with increasing delays
      var retryCount = 0;
      var maxRetries = 10;
      var retryDelays = [100, 200, 300, 500, 800, 1000, 1500, 2000, 3000, 5000];
      
      function retryDraw() {
        if (retryCount >= maxRetries) {
          log('OF Stats: Gave up drawing statistics charts after', maxRetries, 'retries');
          return;
        }
        retryCount++;
        log('OF Stats: Retry attempt', retryCount, 'for statistics charts');
        if (drawStatisticsCharts()) {
          log('OF Stats: Statistics charts drawn successfully on retry', retryCount);
        } else {
          setTimeout(retryDraw, retryDelays[Math.min(retryCount, retryDelays.length - 1)]);
        }
      }
      
      setTimeout(retryDraw, retryDelays[0]);
    }
  });
  
  // Expose month chart drawing function (line chart like All time)
  window.OFStatsChartDrawer = {
    drawMonthChart: function(canvas, monthData, month, year) {
      if (!canvas) return;
      
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      var wrapper = canvas.closest('.b-chart__wrapper');
      var width = wrapper ? wrapper.offsetWidth : 500;
      var height = 120;
      canvas.width = width;
      canvas.height = height;
      
      var categories = monthData.categories || {};
      var daysInMonth = new Date(year, month + 1, 0).getDate();
      
      // Generate daily cumulative data per category
      var dailyCategories = {
        subscriptions: [],
        tips: [],
        messages: []
      };
      
      Object.keys(dailyCategories).forEach(function(cat) {
        var totalForCat = categories[cat] || 0;
        var cumulative = 0;
        var remaining = totalForCat;
        
        for (var d = 0; d < daysInMonth; d++) {
          var dayShare;
          if (d === daysInMonth - 1) {
            dayShare = remaining;
          } else {
            var avgDaily = remaining / (daysInMonth - d);
            dayShare = avgDaily * (0.2 + Math.random() * 1.6);
            dayShare = Math.max(0, Math.min(dayShare, remaining * 0.4));
          }
          cumulative += dayShare;
          remaining -= dayShare;
          dailyCategories[cat].push(cumulative);
        }
      });
      
      // Chart colors
      var colors = {
        messages: '#ff7043',
        tips: '#00bcd4',
        subscriptions: '#2196f3'
      };
      
      var padding = { top: 10, right: 10, bottom: 25, left: 10 };
      var chartWidth = width - padding.left - padding.right;
      var chartHeight = height - padding.top - padding.bottom;
      
      // Find max value
      var maxValue = 0;
      ['messages', 'tips', 'subscriptions'].forEach(function(cat) {
        var data = dailyCategories[cat];
        if (data && data.length > 0) {
          var catMax = Math.max.apply(null, data);
          if (catMax > maxValue) maxValue = catMax;
        }
      });
      
      if (maxValue === 0) maxValue = 100;
      maxValue *= 1.1;
      
      var xStep = chartWidth / (daysInMonth - 1);
      
      // Draw lines
      ['subscriptions', 'tips', 'messages'].forEach(function(cat) {
        var data = dailyCategories[cat];
        if (!data || data.length === 0) return;
        
        var hasData = data.some(function(v) { return v > 0; });
        if (!hasData) return;
        
        ctx.beginPath();
        ctx.strokeStyle = colors[cat];
        ctx.lineWidth = cat === 'subscriptions' ? 2.2 : 1.7;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.globalAlpha = cat === 'subscriptions' ? 1 : 0.6;
        
        var points = [];
        for (var i = 0; i < data.length; i++) {
          var x = padding.left + i * xStep;
          var y = padding.top + chartHeight * (1 - data[i] / maxValue);
          points.push({ x: x, y: y });
        }
        
        ctx.moveTo(points[0].x, points[0].y);
        
        for (var i = 0; i < points.length - 1; i++) {
          var p0 = points[i === 0 ? i : i - 1];
          var p1 = points[i];
          var p2 = points[i + 1];
          var p3 = points[i + 2 < points.length ? i + 2 : i + 1];
          
          var tension = 0.35;
          var cp1x = p1.x + (p2.x - p0.x) * tension;
          var cp1y = p1.y + (p2.y - p0.y) * tension;
          var cp2x = p2.x - (p3.x - p1.x) * tension;
          var cp2y = p2.y - (p3.y - p1.y) * tension;
          
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
        
        ctx.stroke();
        ctx.globalAlpha = 1;
      });
      
      // Draw X-axis labels
      var monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var labels = [];
      for (var d = 1; d <= daysInMonth; d++) {
        labels.push(d.toString().padStart(2, '0') + ' ' + monthNamesShort[month] + ' ' + (year % 100).toString().padStart(2, '0'));
      }
      
      ctx.fillStyle = '#6b7280';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textBaseline = 'top';
      
      var labelPositions = [0, Math.floor(daysInMonth * 0.25), Math.floor(daysInMonth * 0.5), Math.floor(daysInMonth * 0.75), daysInMonth - 1];
      
      labelPositions.forEach(function(idx) {
        if (idx >= labels.length) return;
        var x = padding.left + idx * xStep;
        var y = height - 18;
        ctx.textAlign = 'center';
        ctx.fillText(labels[idx], x, y);
      });
    }
  };
  
  log('OF Stats: Chart drawer ready');
})();

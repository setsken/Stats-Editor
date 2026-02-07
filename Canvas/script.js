const mainCanvas = document.querySelector('.b-chart__double-line__main');
const asideCanvas = document.querySelector('.b-chart__double-line__aside');
const tooltipEl = document.querySelector('.b-chart__tooltip');

// Fixed Axis Width from analysis (d=60 in original code)
const Y_AXIS_WIDTH = 60;

// Data Generation
// X Axis: 30 Days from Dec 28, 2025
const startDate = new Date('2025-12-28');
const labels = [];
for (let i = 0; i < 30; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    labels.push(d.getTime()); // Push timestamps or date objects for better handling if needed, but string ok
}

// Manually tuned data to match the visual curve "1 in 1"
// Main Chart: Peaks at start, Jan 4, Jan 11 (high), Jan 18.
const dataMain = [
    600, 450, 240, 235, 200, 150, 160, // Dec 28 - Jan 3
    240, 200, 310, 220, 120, 140, 160, // Jan 4 - Jan 10
    230, 420, 220, 210, 200, 160, 360, // Jan 11 - Jan 17
    320, 290, 180, 260, 210, 180, 100 // Jan 18 - Jan 24 (Extend slightly)
].concat([80, 50, 20]); // Fill to 30 points

// Corrected Data Interpolation to match screenshot
// 0: High ~600
// 1: Drop
// 2: Flat ~240
// 3...
// Let's use a smoother set that visually matches the peaks.
const dataMainFixed = [
    580, 300, 290, 250, 200, 130, 140, 130, // Drop then low
    260, 220, // Peak Jan 4 approx
    400, 280, 135, 145, 150, // Peak before Jan 11?
    420, 200, 190, 180, 120, // Peak Jan 11
    360, 320, 280, 180, 260, // Peak Jan 18
    220, 160, 80, 20
];

// Aside Chart: Generally low, ~12-15 range, matches peaks slightly
const dataAsideFixed = [
    12, 12, 9, 8, 8, 5, 4, 3,
    8, 7, // bump
    14, 13, 5, 6, 6,
    9, 5, 6, 6, 4, // bump
    15, 10, 9, 6, 12, // bump
    9, 5, 2, 1
];

// Ensure 30 points
while(dataMainFixed.length < 30) dataMainFixed.push(dataMainFixed[dataMainFixed.length-1]);
while(dataAsideFixed.length < 30) dataAsideFixed.push(dataAsideFixed[dataAsideFixed.length-1]);


// Shared Options
const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    layout: {
        padding: {
            left: 0, // No left offset - chart starts from the edge
            right: 60, // Space for numbers column
            top: 0,
            bottom: 0
        }
    },
    interaction: {
        mode: 'index',
        intersect: true,
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
            hoverRadius: 6,
            hoverBorderWidth: 2,
            hoverBackgroundColor: '#fff',
            hitRadius: 15
        },
        line: {
            tension: 0,
            borderWidth: 2
        }
    }
};

// Plugin to draw vertical line separating chart from numbers column
// and extend horizontal grid lines into the numbers area
// Also draws tick labels manually to not affect chart size
const drawVerticalSeparator = {
    id: 'drawVerticalSeparator',
    beforeDraw: (chart) => {
        const ctx = chart.ctx;
        const chartArea = chart.chartArea;
        const yScale = chart.scales.y;
        const xScale = chart.scales.x;
        
        ctx.save();
        
        // Draw vertical separator line at right edge of chart area
        ctx.beginPath();
        ctx.moveTo(chartArea.right, chartArea.top);
        ctx.lineTo(chartArea.right, chartArea.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#E0E0E0';
        ctx.stroke();
        
        // Draw horizontal line at bottom of chart area
        ctx.beginPath();
        ctx.moveTo(chartArea.left, chartArea.bottom);
        ctx.lineTo(chart.width + 60, chartArea.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#E0E0E0';
        ctx.stroke();
        
        const isMainChart = yScale.max > 100;
        const isAsideChart = yScale.max <= 100;
        const rightEdge = chart.width;
        
        // For main chart: draw separator line below with vertical grid marks
        if (isMainChart && xScale) {
            // Draw horizontal separator line below chart
            ctx.beginPath();
            ctx.moveTo(chartArea.left, chartArea.bottom + 8);
            ctx.lineTo(rightEdge, chartArea.bottom + 8);
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#E0E0E0';
            ctx.stroke();
            
            // Get actual grid line positions from Chart.js internal data
            const gridLines = xScale._gridLineItems;
            if (gridLines && gridLines.length > 0) {
                // Draw all 5 lines with -90 offset
                gridLines.forEach((line, index) => {
                    const offset = -90;
                    
                    // Draw vertical line in chart area
                    ctx.beginPath();
                    ctx.moveTo(line.x1 + offset, chartArea.top);
                    ctx.lineTo(line.x1 + offset, chartArea.bottom);
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = '#E0E0E0';
                    ctx.stroke();
                    
                    // Draw short line below chart (lower position)
                    ctx.beginPath();
                    ctx.moveTo(line.x1 + offset, chartArea.bottom + 2);
                    ctx.lineTo(line.x1 + offset, chartArea.bottom + 33);
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = '#E0E0E0';
                    ctx.stroke();
                });
                
                // Draw 5th line at chartArea.right (end of chart)
                const fifthLineX = chartArea.right;
                
                // Draw vertical line in chart area
                ctx.beginPath();
                ctx.moveTo(fifthLineX, chartArea.top);
                ctx.lineTo(fifthLineX, chartArea.bottom);
                ctx.lineWidth = 1;
                ctx.strokeStyle = '#E0E0E0';
                ctx.stroke();
                
                // Draw short line below chart
                ctx.beginPath();
                ctx.moveTo(fifthLineX, chartArea.bottom + 2);
                ctx.lineTo(fifthLineX, chartArea.bottom + 30);
                ctx.lineWidth = 1;
                ctx.strokeStyle = '#E0E0E0';
                ctx.stroke();
            }
        }
        
        // For aside chart: draw date labels and extend vertical grid lines down
        if (isAsideChart && xScale) {
            // Extend vertical grid lines down from chart area
            const gridLines = xScale._gridLineItems;
            if (gridLines && gridLines.length > 0) {
                // Draw all 5 lines with -90 offset
                gridLines.forEach((line, index) => {
                    const offset = -90;
                    
                    // Draw vertical line in chart area
                    ctx.beginPath();
                    ctx.moveTo(line.x1 + offset, chartArea.top);
                    ctx.lineTo(line.x1 + offset, chartArea.bottom);
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = '#E0E0E0';
                    ctx.stroke();
                    
                    // Draw short line below chart (lower position)
                    ctx.beginPath();
                    ctx.moveTo(line.x1 + offset, chartArea.bottom + 2);
                    ctx.lineTo(line.x1 + offset, chartArea.bottom + 33);
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = '#E0E0E0';
                    ctx.stroke();
                });
                
                // Draw 5th line at chartArea.right (end of chart)
                const fifthLineX = chartArea.right;
                
                // Draw vertical line in chart area
                ctx.beginPath();
                ctx.moveTo(fifthLineX, chartArea.top);
                ctx.lineTo(fifthLineX, chartArea.bottom);
                ctx.lineWidth = 1;
                ctx.strokeStyle = '#E0E0E0';
                ctx.stroke();
                
                // Draw short line below chart
                ctx.beginPath();
                ctx.moveTo(fifthLineX, chartArea.bottom + 2);
                ctx.lineTo(fifthLineX, chartArea.bottom + 30);
                ctx.lineWidth = 1;
                ctx.strokeStyle = '#E0E0E0';
                ctx.stroke();
            }
            

            // Draw date labels
            ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#000';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            
            // Debug: log grid lines count
            console.log('Grid lines count:', gridLines ? gridLines.length : 0);
            if (gridLines && gridLines.length > 0) {
                console.log('Grid line positions:', gridLines.map(g => g.x1));
            }
            console.log('ChartArea.right:', chartArea.right);
            console.log('ChartArea.left:', chartArea.left);
            
            // Draw date labels every 7 days, positioned after vertical lines
            // gridLines array corresponds to the visible grid lines (every 7 days)
            const dateIndices = [1, 8, 15, 22, 29];
            
            // Calculate spacing between grid lines
            const spacing = gridLines && gridLines.length > 1 ? gridLines[1].x1 - gridLines[0].x1 : 0;
            
            console.log('Calculated spacing:', spacing);
            console.log('Starting date loop, dateIndices:', dateIndices);
            
            dateIndices.forEach((dateIndex, gridIndex) => {
                console.log(`Processing gridIndex ${gridIndex}, dateIndex ${dateIndex}`);
                // Only draw first 4 dates in the loop, 5th will be drawn separately
                if (gridIndex >= 4) {
                    console.log(`Skipping gridIndex ${gridIndex} (>= 4)`);
                    return;
                }
                
                if (gridLines) {
                    console.log(`gridLines exists, length: ${gridLines.length}, accessing gridLines[${gridIndex}]`);
                    // Use gridLines position with offset for all dates
                    const gridLineX = gridLines[gridIndex].x1;
                    const offset = +43; // Reduced offset to shift dates to the right
                    let x = gridLineX + offset + 5;
                    
                    // If date goes off screen to the left, position it at chartArea.left
                    if (x < chartArea.left) {
                        x = chartArea.left + 5;
                    }
                    console.log(`Date ${gridIndex} (day ${dateIndex}): gridLineX=${gridLineX}, x=${x}`);
                    
                    const d = new Date(startDate);
                    d.setDate(startDate.getDate() + dateIndex);
                    const line1 = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ',';
                    const line2 = d.getFullYear().toString();
                    
                    console.log(`About to draw: ${line1} ${line2} at x=${x}`);
                    ctx.fillText(line1, x, chartArea.bottom + 6);
                    ctx.fillText(line2, x, chartArea.bottom + 18);
                    console.log(`Successfully drew date ${gridIndex}`);
                }
            });
            
            // Draw 5th date at the end (chartArea.right)
            const fifthDateIndex = 29;
            const d5 = new Date(startDate);
            d5.setDate(startDate.getDate() + fifthDateIndex);
            const line1_5th = d5.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ',';
            const line2_5th = d5.getFullYear().toString();
            const x5 = chartArea.right + 5;
            
            console.log(`Drawing 5th date (day ${fifthDateIndex}): x5=${x5}, date=${line1_5th} ${line2_5th}`);
            
            ctx.fillText(line1_5th, x5, chartArea.bottom + 6);
            ctx.fillText(line2_5th, x5, chartArea.bottom + 18);
        }
        
        // Extend horizontal grid lines into the numbers column (right padding area)
        
        if (yScale && yScale.ticks) {
            ctx.font = '450 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#000';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            
            yScale.ticks.forEach((tick) => {
                const y = yScale.getPixelForValue(tick.value);
                
                // Find the line one level below 200 (which should be 0 or 100)
                const isMainValue = tick.value === 0 || tick.value === 100;
                const lineWidth = isMainValue ? 1 : 1;
                const strokeStyle = isMainValue ? '#CCCCCC' : '#E0E0E0';
                
                // Draw full grid line from left to right for the main value
                if (isMainValue) {
                    ctx.beginPath();
                    ctx.moveTo(chartArea.left, y);
                    ctx.lineTo(rightEdge, y);
                    ctx.lineWidth = lineWidth;
                    ctx.strokeStyle = strokeStyle;
                    ctx.stroke();
                } else {
                    // Draw extended grid line (right part only) for other values
                    ctx.beginPath();
                    ctx.moveTo(chartArea.right, y);
                    ctx.lineTo(rightEdge, y);
                    ctx.lineWidth = lineWidth;
                    ctx.strokeStyle = strokeStyle;
                    ctx.stroke();
                }
                
                // Draw tick label (skip 0)
                if (tick.value !== 0) {
                    let label = tick.value;
                    // Check if this is the main chart (max 600) or aside (max 20)
                    if (yScale.max > 100) {
                        label = '$' + tick.value;
                    }
                    ctx.fillText(label, rightEdge - 2, y + 10);
                }
            });
        }
        
        ctx.restore();
    }
};

// Main Chart
const chartMain = new Chart(mainCanvas, {
    type: 'line',
    data: {
        labels: labels,
        datasets: [{
            label: 'Earnings',
            data: dataMainFixed,
            borderColor: '#00aff0',
            backgroundColor: 'rgba(41, 182, 246, 0.1)',
            fill: true,
            pointHoverBorderColor: '#29B6F6',
            clip: false
        }]
    },
    options: {
        ...commonOptions,
        layout: {
            padding: {
                left: 0,
                right: 60,
                top: 0,
                bottom: 8 // Space for separator line with vertical marks
            }
        },
        scales: {
            x: {
                display: true,
                offset: false,
                bounds: 'data',
                grid: {
                    display: false, // Disable default grid, draw manually in plugin
                    drawBorder: false,
                    color: function(context) {
                        // Hide first grid line
                        return context.index === 0 ? 'transparent' : '#E0E0E0';
                    },
                    drawOnChartArea: false,
                    drawTicks: false,
                    offset: false,
                    lineWidth: 1
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
                max: 600,
                border: { display: false },
                grid: {
                    color: '#E0E0E0',
                    drawBorder: false,
                    drawTicks: false
                },
                ticks: {
                    display: false,
                    mirror: false,
                    font: { 
                        size: 11, 
                        family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto',
                        weight: 'bold'
                    },
                    color: '#000',
                    stepSize: 200,
                    autoSkip: false,
                    maxTicksLimit: 4,
                    callback: function(value) { 
                        if (value === 0) return ''; 
                        return '$' + value; 
                    },
                    z: 1 
                }
            }
        },
        plugins: {
            ...commonOptions.plugins,
            tooltip: {
                ...commonOptions.plugins.tooltip,
                callbacks: {
                     title: (items) => {
                         const d = new Date(startDate);
                         d.setDate(startDate.getDate() + items[0].dataIndex);
                         return d.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
                     }
                }
            }
        }
    },
    plugins: [drawVerticalSeparator]
});

// Aside Chart
const chartAside = new Chart(asideCanvas, {
    type: 'line',
    data: {
        labels: labels,
        datasets: [{
            label: 'Transactions',
            data: dataAsideFixed,
            borderColor: '#8a96a3', 
            backgroundColor: 'rgba(144, 164, 174, 0.15)',
            fill: true,
            pointHoverBorderColor: '#8a96a3',
            clip: false
        }]
    },
    options: {
        ...commonOptions,
        layout: {
            padding: {
                left: 0,
                right: 60,
                top: 0,
                bottom: 45 // Space for date labels drawn by plugin
            }
        },
        scales: {
            x: {
                display: true,
                offset: false,
                grid: {
                    display: false, // Disable default grid, draw manually in plugin
                    drawBorder: false,
                    color: function(context) {
                        // Hide first grid line
                        return context.index === 0 ? 'transparent' : '#E0E0E0';
                    },
                    drawOnChartArea: false, 
                    drawTicks: false,
                    offset: false
                },
                ticks: {
                    display: false, // Hide default labels, draw manually in plugin
                    maxRotation: 0,
                    autoSkip: false,
                    callback: function(val, index) {
                        // Show tick only every 7 days to control grid lines (5 ticks total)
                        if (index % 7 === 0) {
                            return '';
                        }
                        return null;
                    }
                }
            },
            y: {
                position: 'right',
                min: 0,
                max: 20,
                border: { display: false },
                grid: {
                    color: '#E0E0E0',
                    drawBorder: false,
                    drawTicks: false
                },
                ticks: {
                    display: false,
                    mirror: false,
                    stepSize: 10, 
                    font: { 
                        size: 11, 
                        family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto',
                        weight: 'bold'
                    },
                    color: '#000',
                    maxTicksLimit: 4,
                    callback: function(value) {
                        if (value === 0 || value > 20) return '';
                        return value;
                    },
                    z: 1
                }
            }
        }
    },
    plugins: [drawVerticalSeparator]
});

// Tooltip Handler (Same logic, slightly refined positioning)
let lastTooltipIndex = -1;

function externalTooltipHandler(context) {
    const {chart, tooltip} = context;
    if (tooltip.opacity === 0) {
        if (tooltipEl.style.opacity !== '0') tooltipEl.style.opacity = 0;
        lastTooltipIndex = -1;
        return;
    }

    if (tooltip.dataPoints && tooltip.dataPoints.length > 0) {
        const index = tooltip.dataPoints[0].dataIndex;
        
        // Hide tooltip immediately when moving to a different point
        if (lastTooltipIndex !== -1 && lastTooltipIndex !== index) {
            tooltipEl.style.opacity = 0;
        }
        lastTooltipIndex = index;
        
        // Update texts
        const d = new Date(startDate);
        d.setDate(startDate.getDate() + index);
        const titleText = d.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
        
        tooltipEl.querySelector('.b-chart__tooltip__title').innerText = titleText;
        
        const valEls = tooltipEl.querySelectorAll('.b-chart__tooltip__text__value');
        if (valEls[0]) valEls[0].innerText = '$' + dataMainFixed[index].toFixed(2);
        if (valEls[1]) valEls[1].innerText = dataAsideFixed[index];
    }

    const canvasRect = chart.canvas.getBoundingClientRect();
    const containerRect = chart.canvas.parentElement.parentElement.getBoundingClientRect();
    
    // Position relative to the container
    const positionX = canvasRect.left - containerRect.left;
    const positionY = canvasRect.top - containerRect.top;
    
    // Position
    tooltipEl.style.opacity = 1;

    // Get tooltip dimensions
    const tooltipWidth = tooltipEl.offsetWidth || 160;
    const tooltipHeight = tooltipEl.offsetHeight || 80;
    const chartWidth = chart.width;
    const caretX = tooltip.caretX;
    const caretY = tooltip.caretY;
    
    // Default: position tooltip to the right of the point with small offset
    let left = positionX + caretX + 15;
    
    // If tooltip goes beyond right edge, position it to the left of the point
    if (caretX + tooltipWidth + 15 > chartWidth) {
        left = positionX + caretX - tooltipWidth - 15;
    }
    
    // Center tooltip vertically on the point
    let top = positionY + caretY - (tooltipHeight / 2);
    
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
}

// Sync hover between charts
let lastHoveredIndex = -1;

function syncChartHover(sourceChart, targetChart, index) {
    if (index !== lastHoveredIndex) {
        lastHoveredIndex = index;
        if (index >= 0) {
            targetChart.setActiveElements([{datasetIndex: 0, index: index}]);
        } else {
            targetChart.setActiveElements([]);
        }
        targetChart.render();
    }
}

// Add mouse event listeners after charts are created
mainCanvas.addEventListener('mousemove', (e) => {
    const points = chartMain.getElementsAtEventForMode(e, 'index', { intersect: true }, false);
    if (points.length > 0) {
        syncChartHover(chartMain, chartAside, points[0].index);
    } else {
        // No point under cursor, clear sync
        if (lastHoveredIndex !== -1) {
            lastHoveredIndex = -1;
            chartAside.setActiveElements([]);
            chartAside.render();
        }
    }
});

mainCanvas.addEventListener('mouseleave', () => {
    lastHoveredIndex = -1;
    chartAside.setActiveElements([]);
    chartAside.render();
});

asideCanvas.addEventListener('mousemove', (e) => {
    const points = chartAside.getElementsAtEventForMode(e, 'index', { intersect: true }, false);
    if (points.length > 0) {
        syncChartHover(chartAside, chartMain, points[0].index);
    } else {
        // No point under cursor, clear sync
        if (lastHoveredIndex !== -1) {
            lastHoveredIndex = -1;
            chartMain.setActiveElements([]);
            chartMain.render();
        }
    }
});

asideCanvas.addEventListener('mouseleave', () => {
    lastHoveredIndex = -1;
    chartMain.setActiveElements([]);
    chartMain.render();
});
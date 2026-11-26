'use strict';

/** Zeichnet die Spielfigur nur aus Canvas-Primitiven. */
function drawFigure(ctx, x, y, radius, color, lookX = 0, lookY = 0.4) {
  const outline = '#1d1b18';
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = radius * 0.13;
  ctx.strokeStyle = outline;

  // Füße
  ctx.fillStyle = outline;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * radius * 0.45, radius * 0.86, radius * 0.3, radius * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Körper
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.86, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Augen folgen der Laufrichtung
  for (const side of [-1, 1]) {
    const eyeX = side * radius * 0.3 + lookX * radius * 0.12;
    const eyeY = -radius * 0.12 + lookY * radius * 0.1;
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = radius * 0.07;
    ctx.beginPath();
    ctx.arc(eyeX, eyeY, radius * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = outline;
    ctx.beginPath();
    ctx.arc(eyeX + lookX * radius * 0.09, eyeY + lookY * radius * 0.09, radius * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Passt ein Canvas an seine Anzeigegröße an und zeichnet die Figur mittig. */
function renderFigureCanvas(canvas, color) {
  const size = canvas.clientWidth;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(size * scale);
  canvas.height = Math.round(size * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (color) drawFigure(ctx, size / 2, size / 2, size * 0.42, color);
}

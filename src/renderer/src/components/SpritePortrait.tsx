import { useEffect, useRef } from 'react';
import { paintCastPortrait, type OfficeCharacterName } from '@/scene/office/cast';
import { PORTRAIT_W, PORTRAIT_H } from '@/scene/office/portraitArt';

const FRAME_W = PORTRAIT_W;
const FRAME_H = PORTRAIT_H;

export interface SpritePortraitProps {
  character: OfficeCharacterName;
  scale?: number; // integer
  background?: string;
}

/** Static standing portrait of an Office cast member (recolored LimeZu sprite). */
export function SpritePortrait({
  character,
  scale = 2,
  background = 'transparent'
}: SpritePortraitProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let cancelled = false;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    paintCastPortrait(ctx, character, scale).catch(() => { /* asset load race */ });
    return () => { cancelled = true; void cancelled; };
  }, [character, scale, background]);

  return (
    <canvas
      ref={canvasRef}
      width={FRAME_W * scale}
      height={FRAME_H * scale}
      style={{
        width: FRAME_W * scale,
        height: FRAME_H * scale,
        imageRendering: 'pixelated'
      }}
    />
  );
}

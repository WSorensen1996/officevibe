// Design tokens for non-styled (Pixi) consumers. The full palette + spacing/type
// scales live in tokens.css; this file mirrors only the tokens the scene reads.

export const colors = {
  cream: {
    50: 0xfffdf5,
    100: 0xfff8e7,
    200: 0xf4e9c7,
    300: 0xe8d9a0
  },
  ink: {
    900: 0x1a1320,
    700: 0x3d2e4a,
    500: 0x6b5878,
    300: 0xa899b5,
    100: 0xd9cfe0
  },
  accent: {
    coral: 0xff6b6b,
    coralLight: 0xffb4b4,
    mint: 0x6bcf7f,
    mintLight: 0xb4e5bd,
    sky: 0x4ecdc4,
    skyLight: 0xa8e6e0,
    lemon: 0xffd93d,
    lemonLight: 0xffec99,
    lilac: 0xb197fc,
    lilacLight: 0xd6c5ff,
    peach: 0xffa07a,
    peachLight: 0xffd0b5
  }
} as const;

export type AccentColorName =
  | 'coral' | 'mint' | 'sky' | 'lemon' | 'lilac' | 'peach';

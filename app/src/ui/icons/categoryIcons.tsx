import { Platform } from "react-native";
import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg";

import type { UserSettings } from "../../generated/schema";
import { colors } from "../theme";

export type IconVariant = UserSettings["icon_style"];

// "body" shapes make the glyph. "cut" shapes are holes: in the filled style
// they use the background colour. "line" shapes are always strokes.
type Role = "body" | "cut" | "line" | "cutLine";

type Shape =
  | { kind: "path"; d: string; role?: Role }
  | { kind: "rect"; x: number; y: number; width: number; height: number; rx?: number; role?: Role }
  | { kind: "circle"; cx: number; cy: number; r: number; role?: Role }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; role?: Role };

type IconDef = { label: string; shapes: Shape[] };

const p = (d: string, role?: Role): Shape => ({ kind: "path", d, role });
const r = (x: number, y: number, width: number, height: number, rx?: number, role?: Role): Shape => ({
  kind: "rect", x, y, width, height, rx, role,
});
const c = (cx: number, cy: number, radius: number, role?: Role): Shape => ({ kind: "circle", cx, cy, r: radius, role });

// Paths on a 32 by 32 grid. The first twelve come from the approved mockup.
const defs = {
  fork: {
    label: "Fork and knife",
    shapes: [
      p("M7 3h2v8h1V3h2v8h1V3h2v10c0 2-1.5 3.3-3 3.7V30H10V16.7C8.5 16.3 7 15 7 13Z"),
      p("M20 3c4 0 6 4 6 11h-2.5V30h-4Z"),
    ],
  },
  cart: {
    label: "Shopping cart",
    shapes: [
      p("M2 6h4.5l1 3", "line"),
      p("M8 9h22l-3 11H10Z"),
      p("M11 11h2v7h-2zM15 11h2v7h-2zM19 11h2v7h-2zM23 11h2v7h-2z", "cut"),
      c(12, 26, 2.5),
      c(25, 26, 2.5),
    ],
  },
  groceries: {
    label: "Groceries",
    shapes: [
      p("M3 9h11l-1.5 19H4.5Z"),
      p("M9 9 12 2", "line"),
      r(15, 17, 15, 3.5, 1.7),
      r(15, 22, 15, 2.5),
      r(15, 26, 15, 3, 1),
    ],
  },
  music: {
    label: "Music player",
    shapes: [r(7, 2, 18, 28, 2.5), r(10, 5, 12, 9, 0, "cut"), c(16, 22, 5, "cut"), c(16, 22, 2)],
  },
  bus: {
    label: "Bus",
    shapes: [
      p("M6 6c0-3 3-4 10-4s10 1 10 4v20h-2v3h-4v-3h-8v3H8v-3H6Z"),
      r(8.5, 8, 15, 8, 1, "cut"),
      c(10, 21, 1.8, "cut"),
      c(22, 21, 1.8, "cut"),
    ],
  },
  flame: {
    label: "Flame",
    shapes: [
      p("M16 2c1 6 9 9 9 18a9 9 0 0 1-18 0c0-5 3-7 4-11 1 3 2 4 3 5 1-4 2-8 2-12Z"),
      p("M16 19c2 2 4 3 4 6a4 4 0 0 1-8 0c0-2 2-3 4-6Z", "cut"),
    ],
  },
  tax: {
    label: "Tax",
    shapes: [
      p("M9 3h10l4 4v9H9Z"),
      p("M3 17h26v10H3Z"),
      r(5, 28, 22, 2),
      p("M11 7h7v1.4h-7zM11 10h9v1.4h-9z", "cut"),
    ],
  },
  gift: {
    label: "Gift",
    shapes: [
      r(4, 11, 24, 7, 1),
      r(6, 19, 20, 11, 1),
      p("M16 11c-3-7-10-7-9-2 1 3 6 2 9 2Zm0 0c3-7 10-7 9-2-1 3-6 2-9 2Z", "line"),
      r(14.6, 11, 2.8, 19, 0, "cut"),
    ],
  },
  key: {
    label: "Key",
    shapes: [c(11, 11, 8), c(8.5, 8.5, 2.3, "cut"), p("M15 17 28 30l2-2-2-2 2-2-2-2-2 2-2-2-5-5Z")],
  },
  calculator: {
    label: "Calculator",
    shapes: [
      r(5, 2, 22, 28, 3),
      r(8, 5, 16, 6, 1, "cut"),
      ...[15.5, 21, 26.3].flatMap((cy) => [10, 16, 22].map((cx) => c(cx, cy, 1.9, "cut"))),
    ],
  },
  book: {
    label: "Book",
    shapes: [p("M8 3h14l3 3v24H11l-3-3Z"), p("M11 6h14v24", "cutLine")],
  },
  tag: {
    label: "Price tag",
    shapes: [p("M18 8 27 7 26 16 13 29 5 21Z"), c(22, 12, 1.6, "cut"), p("M23 11c3-4 7-6 8-4", "line")],
  },
  piggy: {
    label: "Piggy bank",
    shapes: [
      p("M7 13c2-4 7-6 12-6 6 0 10 3 11 7l1.5.2v4.6L29 19c-1 2-2.5 3.5-4 4.5V28h-4v-3c-2 .4-4 .4-6 0v3h-4v-4.5C8 22 6 19.6 5.6 17H3v-4Z"),
      c(24.5, 13, 1.2, "cut"),
      p("M15 9.5h5", "cutLine"),
    ],
  },
  coins: {
    label: "Coins",
    shapes: [
      p("M5 8c0-2.2 4.9-4 11-4s11 1.8 11 4v16c0 2.2-4.9 4-11 4S5 26.2 5 24Z"),
      p("M5 8c0 2.2 4.9 4 11 4s11-1.8 11-4M5 16c0 2.2 4.9 4 11 4s11-1.8 11-4", "cutLine"),
    ],
  },
  car: {
    label: "Car",
    shapes: [
      p("M4 17l3-8c.5-1.3 1.6-2 3-2h12c1.4 0 2.5.7 3 2l3 8v8h-3v3h-4v-3H11v3H7v-3H4Z"),
      p("M8.5 15l2-5.5h11l2 5.5Z", "cut"),
      c(8.5, 20, 1.8, "cut"),
      c(23.5, 20, 1.8, "cut"),
    ],
  },
  home: {
    label: "Home",
    shapes: [p("M16 3 2 15h4v14h8v-8h4v8h8V15h4Z")],
  },
  health: {
    label: "Health",
    shapes: [
      p("M16 28C7 21 3 16 3 11a6.5 6.5 0 0 1 13-2 6.5 6.5 0 0 1 13 2c0 5-4 10-13 17Z"),
      p("M14.5 11h3v3h3v3h-3v3h-3v-3h-3v-3h3Z", "cut"),
    ],
  },
  phone: {
    label: "Phone",
    shapes: [r(9, 2, 14, 28, 2.5), r(11, 5, 10, 18, 0, "cut"), c(16, 26.5, 1.5, "cut")],
  },
  coffee: {
    label: "Coffee",
    shapes: [
      p("M4 10h19v9a7 7 0 0 1-7 7h-5a7 7 0 0 1-7-7Z"),
      p("M23 13h2.5a3.5 3.5 0 0 1 0 7H22", "line"),
      r(3, 27, 22, 2.5, 1.2),
      p("M10 3c-1.5 2 1.5 3 0 5M16 3c-1.5 2 1.5 3 0 5", "line"),
    ],
  },
  plane: {
    label: "Plane",
    shapes: [
      p("M29 4c-1-1-3-.5-4.5 1L19 10.5 6 7 3.5 9.5 14 15l-5 5.5-4-.5L3 22l5 2 2 5 2-2-.5-4 5.5-5 5.5 10.5L25 26l-3.5-13L27 8.5c1.5-1.5 2-3.5 1-4.5Z"),
    ],
  },
  baby: {
    label: "Baby",
    shapes: [
      c(16, 12, 9),
      c(12.5, 11, 1.3, "cut"),
      c(19.5, 11, 1.3, "cut"),
      p("M13 15.5c1.8 1.5 4.2 1.5 6 0", "cutLine"),
      p("M8 30c0-5 3.5-8 8-8s8 3 8 8Z"),
    ],
  },
  shirt: {
    label: "Shirt",
    shapes: [p("M11 3 3 7l3 7 3-1.5V29h14V12.5l3 1.5 3-7-8-4c-.5 2.5-2.5 4-5 4s-4.5-1.5-5-4Z")],
  },
  sport: {
    label: "Sport",
    shapes: [c(16, 16, 13), p("M3 16h26M16 3v26M7 7c4 4 4 14 0 18M25 7c-4 4-4 14 0 18", "cutLine")],
  },
  pet: {
    label: "Pet",
    shapes: [
      p("M16 17c4 0 8 5 8 9 0 2.5-2 3.5-4 3-1.5-.4-2.5-1-4-1s-2.5.6-4 1c-2 .5-4-.5-4-3 0-4 4-9 8-9Z"),
      { kind: "ellipse", cx: 7, cy: 14, rx: 2.8, ry: 3.4 },
      { kind: "ellipse", cx: 12, cy: 8, rx: 2.8, ry: 3.4 },
      { kind: "ellipse", cx: 20, cy: 8, rx: 2.8, ry: 3.4 },
      { kind: "ellipse", cx: 25, cy: 14, rx: 2.8, ry: 3.4 },
    ],
  },
} satisfies Record<string, IconDef>;

export type CategoryIconKey = keyof typeof defs;

export const categoryIcons: Record<CategoryIconKey, IconDef> = defs;

export const categoryIconKeys = Object.keys(defs) as CategoryIconKey[];

function paint(role: Role, variant: IconVariant, color: string, background: string) {
  if (role === "line") {
    return { fill: "none", stroke: color, strokeWidth: 1.8 };
  }
  if (variant === "outline") {
    return { fill: "none", stroke: color, strokeWidth: role === "body" ? 1.8 : 1.3 };
  }
  if (role === "cutLine") {
    return { fill: "none", stroke: background, strokeWidth: 1.4 };
  }
  return { fill: role === "cut" ? background : color };
}

type Props = {
  icon: CategoryIconKey;
  variant?: IconVariant;
  size?: number;
  color?: string;
  /** Colour behind the icon. The filled style paints the holes with it. */
  background?: string;
};

export function CategoryIcon({
  icon,
  variant = "filled",
  size = 30,
  color = colors.light.ink,
  background = colors.light.row,
}: Props) {
  const def = categoryIcons[icon];
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      // react-native-svg passes `accessible` to the DOM on the web, and React warns about it.
      {...(Platform.OS === "web" ? {} : { accessible: true })}
      accessibilityRole="image"
      accessibilityLabel={def.label}
      testID={`category-icon-${icon}-${variant}`}
    >
      {def.shapes.map((shape, i) => {
        const props = { strokeLinejoin: "round" as const, ...paint(shape.role ?? "body", variant, color, background) };
        switch (shape.kind) {
          case "path":
            return <Path key={i} {...props} d={shape.d} />;
          case "rect":
            return <Rect key={i} {...props} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />;
          case "circle":
            return <Circle key={i} {...props} cx={shape.cx} cy={shape.cy} r={shape.r} />;
          case "ellipse":
            return <Ellipse key={i} {...props} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />;
        }
      })}
    </Svg>
  );
}

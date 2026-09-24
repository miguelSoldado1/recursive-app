import { useMutation, useQuery } from "lakebed/client";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  RELATED_ARTIST_LIMIT,
  ROOT_RELATED_ARTIST_LIMIT,
  kendrickLamarFallback,
  type ArtistNeighborhood,
  type ArtistNeighborhoodResult,
  type ArtistPreviewsResult,
  type ArtistSearchResult,
  type ArtistSummary,
  type TrackPreview
} from "../shared/artist";

type ChildrenStatus = "idle" | "loading" | "loaded" | "error";
type SearchStatus = "idle" | "searching" | "error";
type TreeNode = {
  id: string;
  artistId: string;
  label: string;
  imageUrl?: string;
  url?: string;
  previews?: TrackPreview[];
  depth: number;
  angle: number;
  childIndex: number;
  x: number;
  y: number;
  childrenStatus: ChildrenStatus;
  error?: string;
  parentId?: string;
};

type TreeState = Record<string, TreeNode>;
type NodeRole = "focus" | "parent" | "child" | "ancestor" | "ghost";
type EdgeRole = "parent" | "route" | "child";
type OrbitRing = {
  id: string;
  x: number;
  y: number;
  radius: number;
  role: "inner" | "current" | "next" | "horizon";
};

type Camera = {
  scale: number;
  x: number;
  y: number;
};

const SIZE = 1000;
const CENTER = SIZE / 2;
const ROOT_CHILDREN = ROOT_RELATED_ARTIST_LIMIT;
const CHILDREN_PER_NODE = RELATED_ARTIST_LIMIT;
const RING_STEP = 330;
const CHILD_SPACING = 280;
const MAX_CHILD_STEP_DEGREES = 40;
const BASE_CAMERA_SCALE = 1.16;
const CAMERA_SCALE_PER_DEPTH = 0.08;
const MAX_CAMERA_SCALE = 1.42;
const CAMERA_FIT_RADIUS = 395;
const MIN_CAMERA_SCALE = 0.96;
const CAMERA_BALANCE = 0.3;
const PREVIEW_STUB_LENGTH = 0.42;
const FOCUS_RADIUS = 68;
const PARENT_RADIUS = 43;
const CHILD_RADIUS = 48;
const GHOST_RADIUS = 24;
const LOAD_THROTTLE_MS = 120;

const rootNode: TreeNode = {
  id: "core",
  artistId: kendrickLamarFallback.id,
  label: kendrickLamarFallback.name,
  imageUrl: kendrickLamarFallback.imageUrl,
  url: kendrickLamarFallback.url,
  depth: 0,
  angle: -90,
  childIndex: 0,
  childrenStatus: "idle",
  x: CENTER,
  y: CENTER
};

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function pointFrom(origin: { x: number; y: number }, distance: number, angle: number) {
  const radians = toRadians(angle);

  return {
    x: origin.x + Math.cos(radians) * distance,
    y: origin.y + Math.sin(radians) * distance
  };
}

function cameraFor(tree: TreeState, node: TreeNode): Camera {
  const desiredScale = Math.min(MAX_CAMERA_SCALE, BASE_CAMERA_SCALE + node.depth * CAMERA_SCALE_PER_DEPTH);
  const parent = node.parentId ? tree[node.parentId] : undefined;
  const loadedChildren = getChildren(tree, node);
  const childPoints =
    loadedChildren.length > 0
      ? loadedChildren
      : planChildAngles(node).map((angle) => childPoint(node, angle));
  const localPoints = [parent, ...childPoints].filter((point): point is { x: number; y: number } => Boolean(point));
  // Children always sit further out than the parent, so aim between the focus and the middle of its
  // neighborhood; otherwise the view is empty on the inward side and crowded on the outward side.
  const centroid = localPoints.reduce((sum, point) => ({ x: sum.x + point.x / localPoints.length, y: sum.y + point.y / localPoints.length }), { x: 0, y: 0 });
  const anchor =
    localPoints.length > 0
      ? { x: node.x + (centroid.x - node.x) * CAMERA_BALANCE, y: node.y + (centroid.y - node.y) * CAMERA_BALANCE }
      : { x: node.x, y: node.y };
  const farthestLocalPoint = [node, ...localPoints].reduce((distance, point) => Math.max(distance, Math.hypot(point.x - anchor.x, point.y - anchor.y)), 0);
  const fitScale = farthestLocalPoint > 0 ? CAMERA_FIT_RADIUS / farthestLocalPoint : desiredScale;
  const scale = Math.max(MIN_CAMERA_SCALE, Math.min(desiredScale, fitScale));

  return {
    scale,
    x: CENTER - anchor.x * scale,
    y: CENTER - anchor.y * scale
  };
}

function easeInOutCubic(value: number) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function getChildCount(node: TreeNode) {
  return node.id === rootNode.id ? ROOT_CHILDREN : CHILDREN_PER_NODE;
}

function ringRadius(depth: number) {
  return depth * RING_STEP;
}

// Like a solar system: every artist sits on the orbit that matches how many jumps it is from where you
// started. Children land on the next ring out, centered on their parent's bearing from the origin.
function planChildAngles(parent: TreeNode) {
  const count = getChildCount(parent);

  if (parent.id === rootNode.id) {
    return Array.from({ length: count }, (_, childIndex) => -90 + childIndex * (360 / count));
  }

  const step = Math.min(MAX_CHILD_STEP_DEGREES, (CHILD_SPACING / ringRadius(parent.depth + 1)) * (180 / Math.PI));
  return Array.from({ length: count }, (_, childIndex) => parent.angle + (childIndex - (count - 1) / 2) * step);
}

function childPoint(parent: TreeNode, angle: number) {
  return pointFrom({ x: CENTER, y: CENTER }, ringRadius(parent.depth + 1), angle);
}

function makeNodeId(parent: TreeNode, childIndex: number, artist: ArtistSummary) {
  return `${parent.id}-${childIndex + 1}-${artist.id}`;
}

function artistFields(artist: ArtistSummary) {
  return {
    artistId: artist.id,
    label: artist.name,
    imageUrl: artist.imageUrl,
    url: artist.url
  };
}

function makeRootNode(artist: ArtistSummary, childrenStatus: ChildrenStatus = "idle"): TreeNode {
  return {
    ...rootNode,
    ...artistFields(artist),
    childrenStatus,
    error: undefined
  };
}

function makeChild(parent: TreeNode, childIndex: number, artist: ArtistSummary, angle: number): TreeNode {
  const id = makeNodeId(parent, childIndex, artist);
  const point = childPoint(parent, angle);

  return {
    id,
    ...artistFields(artist),
    depth: parent.depth + 1,
    angle,
    childIndex,
    parentId: parent.id,
    childrenStatus: "idle",
    x: point.x,
    y: point.y
  };
}

function getChildren(tree: TreeState, node: TreeNode) {
  return Object.values(tree)
    .filter((candidate) => candidate.parentId === node.id)
    .sort((a, b) => a.childIndex - b.childIndex);
}

function updateNodeArtist(tree: TreeState, nodeId: string, neighborhood: Pick<ArtistNeighborhood, "artist" | "previews">) {
  const node = tree[nodeId];
  if (!node) {
    return tree;
  }

  return {
    ...tree,
    [nodeId]: {
      ...node,
      ...artistFields(neighborhood.artist),
      previews: neighborhood.previews
    }
  };
}

function setNodeChildrenStatus(tree: TreeState, nodeId: string, childrenStatus: ChildrenStatus, error?: string) {
  const node = tree[nodeId];
  if (!node) {
    return tree;
  }

  return {
    ...tree,
    [nodeId]: {
      ...node,
      childrenStatus,
      error
    }
  };
}

function attachChildren(tree: TreeState, parentId: string, artists: ArtistSummary[]) {
  const parent = tree[parentId];
  if (!parent) {
    return tree;
  }

  const nextTree = setNodeChildrenStatus(tree, parentId, "loaded");
  const existingChildren = getChildren(tree, parent);
  const existingChildByArtistId = new Map(existingChildren.map((child) => [child.artistId, child]));
  // Only artists on the route here are off-limits (that would loop back). Artists hidden in other
  // branches aren't visible, so they can show up again wherever they're a good match.
  const usedArtistIds = new Set(routeTo(tree, parent).map((node) => node.artistId));
  const acceptedArtistIds = new Set<string>();
  const nextChildren: ArtistSummary[] = [];

  for (const artist of artists) {
    const isExistingChild = existingChildByArtistId.has(artist.id);

    if (acceptedArtistIds.has(artist.id) || (usedArtistIds.has(artist.id) && !isExistingChild)) {
      continue;
    }

    acceptedArtistIds.add(artist.id);
    nextChildren.push(artist);

    if (nextChildren.length >= getChildCount(parent)) {
      break;
    }
  }

  const angles = planChildAngles(parent);

  for (let childIndex = 0; childIndex < nextChildren.length; childIndex += 1) {
    const artist = nextChildren[childIndex];
    const existingChild = existingChildByArtistId.get(artist.id);
    const child = existingChild ?? makeChild(parent, childIndex, artist, angles[childIndex]);

    nextTree[child.id] = existingChild
      ? {
          ...existingChild,
          ...artistFields(artist)
        }
      : child;
  }

  return nextTree;
}

function createInitialTree() {
  const core = makeRootNode(kendrickLamarFallback);
  return { [core.id]: core };
}

// Only your route and the focused artist's orbit are visible; everything else stays in the fog.
function buildNodeRoles(tree: TreeState, focusedNode: TreeNode) {
  const roles = new Map<string, NodeRole>();
  roles.set(focusedNode.id, "focus");
  let ancestor = focusedNode.parentId ? tree[focusedNode.parentId] : undefined;

  if (ancestor) {
    roles.set(ancestor.id, "parent");
    ancestor = ancestor.parentId ? tree[ancestor.parentId] : undefined;
  }

  while (ancestor) {
    roles.set(ancestor.id, "ancestor");
    ancestor = ancestor.parentId ? tree[ancestor.parentId] : undefined;
  }

  for (const child of getChildren(tree, focusedNode)) {
    roles.set(child.id, "child");
  }

  return roles;
}

function buildEdges(tree: TreeState, roles: Map<string, NodeRole>) {
  return Object.values(tree).flatMap((node) => {
    const parent = node.parentId ? tree[node.parentId] : undefined;
    const parentRole = parent ? roles.get(parent.id) : undefined;
    const nodeRole = roles.get(node.id);
    let role: EdgeRole | undefined;

    if (parentRole === "parent" && nodeRole === "focus") {
      role = "parent";
    } else if (parentRole === "focus" && nodeRole === "child") {
      role = "child";
    } else if (parentRole === "ancestor" && (nodeRole === "parent" || nodeRole === "ancestor")) {
      role = "route";
    }

    return parent && role ? [{ id: `${parent.id}-${node.id}`, parent, child: node, role }] : [];
  });
}

function buildProjectedPreviewEdges(tree: TreeState, focusedNode: TreeNode) {
  return getChildren(tree, focusedNode).flatMap((child) => {
    const projectedPoints =
      child.childrenStatus === "loaded" ? getChildren(tree, child) : planChildAngles(child).map((angle) => childPoint(child, angle));

    return projectedPoints.map((projectedPoint, childIndex) => {
      return {
        id: `${child.id}-projected-preview-${childIndex}`,
        parentId: child.id,
        x1: child.x,
        y1: child.y,
        // Just a short hint toward the next orbit; the full line would be a spoiler and visual noise.
        x2: child.x + (projectedPoint.x - child.x) * PREVIEW_STUB_LENGTH,
        y2: child.y + (projectedPoint.y - child.y) * PREVIEW_STUB_LENGTH
      };
    });
  });
}

// One ring per distance from the origin: the ring the focused artist orbits on, the ring its neighbors
// sit on, and a faint horizon beyond that where the next jump would land.
function buildOrbitRings(tree: TreeState, focusedNode: TreeNode): OrbitRing[] {
  const hasChildren = getChildren(tree, focusedNode).length > 0;
  const outermost = focusedNode.depth + (hasChildren ? 2 : 0);
  // Far from the origin the rings are nearly straight, so extra ones read as graph paper; keep just
  // the ring you're on and the one your next choices sit on.
  const innermost = focusedNode.depth > 2 ? focusedNode.depth : 1;
  const lastRing = focusedNode.depth > 2 ? Math.min(outermost, focusedNode.depth + 1) : outermost;

  return Array.from({ length: Math.max(0, lastRing - innermost + 1) }, (_, index) => innermost + index).map((depth) => ({
    id: `ring-${depth}`,
    x: CENTER,
    y: CENTER,
    radius: ringRadius(depth),
    role: depth === focusedNode.depth + 2 ? "horizon" : depth === focusedNode.depth + 1 ? "next" : depth === focusedNode.depth ? "current" : "inner"
  }));
}

function nodeRadius(role: NodeRole, node: TreeNode, focusedNode: TreeNode) {
  if (role === "focus") {
    return FOCUS_RADIUS;
  }

  if (role === "parent") {
    return PARENT_RADIUS;
  }

  if (role === "ancestor") {
    return PARENT_RADIUS - 6;
  }

  if (role === "child") {
    // Earlier children are the closest relations, so they read as slightly larger bodies.
    return CHILD_RADIUS - node.childIndex * 2.5;
  }

  return GHOST_RADIUS;
}

function isInteractiveRole(role: NodeRole) {
  return role !== "ghost";
}

function nodeClassName(role: NodeRole, childrenStatus?: ChildrenStatus) {
  return ["node", `node-${role}`, isInteractiveRole(role) ? "node-button" : "", childrenStatus === "loading" ? "node-loading" : ""].filter(Boolean).join(" ");
}

function truncateLabel(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function labelLines(label: string) {
  const words = label.split(/\s+/).filter(Boolean);
  const lines: string[] = [];

  for (const word of words) {
    if (lines.length === 0) {
      lines.push(word);
      continue;
    }

    const currentLine = lines[lines.length - 1] ?? "";
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (candidate.length <= 14) {
      lines[lines.length - 1] = candidate;
    } else if (lines.length < 2) {
      lines.push(word);
    }
  }

  return (lines.length > 0 ? lines : [label]).slice(0, 2).map((line) => truncateLabel(line, 15));
}

function hashText(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function nodeStyle(node: TreeNode, radius: number, cameraScale: number) {
  const seed = hashText(node.id);
  const inverseCameraScale = 1 / cameraScale;
  const worldRadius = radius * inverseCameraScale;
  const driftX = (2.4 + (seed % 13) * 0.22) * inverseCameraScale;
  const driftY = (2.2 + ((seed >> 5) % 13) * 0.2) * inverseCameraScale;
  const duration = 9 + ((seed >> 10) % 18) * 0.32;
  const delay = -1 * (((seed >> 16) % 40) * 0.16);

  return {
    height: `${(worldRadius * 2 * 100) / SIZE}%`,
    left: `${(node.x * 100) / SIZE}%`,
    top: `${(node.y * 100) / SIZE}%`,
    width: `${(worldRadius * 2 * 100) / SIZE}%`,
    "--node-drift-duration": `${duration.toFixed(2)}s`,
    "--node-drift-delay": `${delay.toFixed(2)}s`,
    "--node-drift-x-a": `${driftX.toFixed(2)}px`,
    "--node-drift-y-a": `${(-driftY * 0.45).toFixed(2)}px`,
    "--node-drift-x-b": `${(-driftX * 0.72).toFixed(2)}px`,
    "--node-drift-y-b": `${driftY.toFixed(2)}px`,
    "--node-text-scale": inverseCameraScale.toFixed(4)
  } as Record<string, string>;
}

function cameraStyle(camera: Camera) {
  return {
    transform: `translate(${(camera.x * 100) / SIZE}%, ${(camera.y * 100) / SIZE}%) scale(${camera.scale})`
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function useAnimatedCamera(target: Camera, onRest?: () => void) {
  const [camera, setCamera] = useState<Camera>(target);
  const cameraRef = useRef(target);
  const onRestRef = useRef(onRest);

  useEffect(() => {
    onRestRef.current = onRest;
  }, [onRest]);

  useEffect(() => {
    const start = cameraRef.current;
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    const duration = Math.min(1650, Math.max(900, distance * 2.2));
    let frame = 0;

    if (distance < 0.5 || (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
      cameraRef.current = target;
      setCamera(target);
      onRestRef.current?.();
      return;
    }

    function tick(startTime: number, now: number) {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = easeInOutCubic(progress);
      const next = {
        scale: start.scale + (target.scale - start.scale) * eased,
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased
      };

      cameraRef.current = next;
      setCamera(next);

      if (progress < 1) {
        frame = requestAnimationFrame((nextTime) => tick(startTime, nextTime));
      } else {
        cameraRef.current = target;
        setCamera(target);
        onRestRef.current?.();
      }
    }

    frame = requestAnimationFrame((startTime) => tick(startTime, startTime));

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target.scale, target.x, target.y]);

  return camera;
}

const APP_NAME = "Drift";
// Pale champagne starlight used whenever a photo has no usable color (black-and-white shots, artists
// without a photo, or before an image loads). Warm and quiet enough to read as "no color of its own".
const DEFAULT_TINT = "hsl(42 48% 74%)";
// A star, its orbit, and a warm moon: the solar-system rings in miniature. Lakebed serves no static
// files, so the icons are attached to the document head at startup.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="s" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#e6e2ff"/><stop offset="1" stop-color="#8a7dff" stop-opacity="0"/></radialGradient></defs><rect width="64" height="64" rx="14" fill="#07061a"/><circle cx="32" cy="32" r="21" fill="none" stroke="#8a7dff" stroke-opacity=".75" stroke-width="2.4"/><circle cx="32" cy="32" r="13" fill="url(#s)"/><circle cx="46.8" cy="17.2" r="5.2" fill="#ffb08a"/></svg>`;
const APPLE_TOUCH_ICON = "data:image/png;base64,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";

function installIcons() {
  const icons = [
    { rel: "icon", type: "image/svg+xml", href: `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}` },
    { rel: "apple-touch-icon", type: "image/png", href: APPLE_TOUCH_ICON }
  ];

  for (const icon of icons) {
    let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${icon.rel}"]`);
    if (!link) {
      link = document.createElement("link");
      link.rel = icon.rel;
      document.head.appendChild(link);
    }

    link.type = icon.type;
    link.href = icon.href;
  }
}
// Deezer's API terms require a clearly visible Deezer logo; this is the official mark from deezerbrand.com.
const DEEZER_MARK = "data:image/png;base64,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";
const tintCache = new Map<string, string | null>();
const tintListeners = new Set<() => void>();


// Artists without a photo get a plain grey vinyl record. The label turns; the sheen stays put like a reflection.
function VinylRecord() {
  return (
    <span aria-hidden="true" className="vinyl">
      <span className="vinyl-label" />
      <span className="vinyl-sheen" />
    </span>
  );
}

function shiftHue(tint: string, degrees: number) {
  const match = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(tint);
  if (!match) {
    return tint;
  }

  return `hsl(${(Number(match[1]) + degrees) % 360} ${match[2]}% ${match[3]}%)`;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Pull a luminous hue out of an artist portrait so each planet (and the nebula around the focused one) glows in its own color.
function extractTint(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  const size = 24;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }

  context.drawImage(image, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  let hueX = 0;
  let hueY = 0;
  let weightTotal = 0;
  let saturationTotal = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] / 255;
    const green = pixels[index + 1] / 255;
    const blue = pixels[index + 2] / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const lightness = (max + min) / 2;
    const chroma = max - min;

    if (chroma < 0.08 || lightness < 0.08 || lightness > 0.94) {
      continue;
    }

    const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
    let hue = 0;
    if (max === red) {
      hue = ((green - blue) / chroma) % 6;
    } else if (max === green) {
      hue = (blue - red) / chroma + 2;
    } else {
      hue = (red - green) / chroma + 4;
    }

    const radians = (hue * 60 * Math.PI) / 180;
    const weight = saturation * chroma;
    hueX += Math.cos(radians) * weight;
    hueY += Math.sin(radians) * weight;
    saturationTotal += saturation * weight;
    weightTotal += weight;
  }

  if (weightTotal < 6) {
    return null;
  }

  const hue = ((Math.atan2(hueY, hueX) * 180) / Math.PI + 360) % 360;
  const saturation = Math.round(Math.min(88, Math.max(62, (saturationTotal / weightTotal) * 100)));
  return `hsl(${Math.round(hue)} ${saturation}% 66%)`;
}

function requestTint(url: string) {
  if (tintCache.has(url)) {
    return;
  }

  tintCache.set(url, null);
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    try {
      tintCache.set(url, extractTint(image));
    } catch {
      tintCache.set(url, null);
    }

    tintListeners.forEach((listener) => listener());
  };
  image.src = url;
}

function useTints(urls: string[]) {
  const [, setVersion] = useState(0);
  const key = urls.join("|");

  useEffect(() => {
    const listener = () => setVersion((version) => version + 1);
    tintListeners.add(listener);

    return () => {
      tintListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    urls.forEach(requestTint);
  }, [key]);

  return (url?: string) => (url ? tintCache.get(url) ?? DEFAULT_TINT : DEFAULT_TINT);
}

type Star = { x: number; y: number; radius: number; alpha: number; twinkle: number; phase: number; layer: number; warm: boolean };

const STAR_TILE = 1400;
const STAR_LAYERS = [
  { count: 520, depth: 0.06, size: [0.3, 0.75], alpha: [0.16, 0.5] },
  { count: 170, depth: 0.16, size: [0.5, 1.1], alpha: [0.3, 0.75] },
  { count: 42, depth: 0.36, size: [0.9, 1.8], alpha: [0.55, 1] }
];

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function frameSizeFor(width: number, height: number) {
  return width <= 640 ? Math.min(width, height * 0.78) : Math.min(Math.min(width, height) * 0.94, width - 24, 960);
}

function Starfield({ camera }: { camera: Camera }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }

    const random = seededRandom(11);
    const stars: Star[] = STAR_LAYERS.flatMap((layer, layerIndex) =>
      Array.from({ length: layer.count }, () => ({
        x: random() * STAR_TILE,
        y: random() * STAR_TILE,
        radius: layer.size[0] + random() * (layer.size[1] - layer.size[0]),
        alpha: layer.alpha[0] + random() * (layer.alpha[1] - layer.alpha[0]),
        twinkle: 0.4 + random() * 1.4,
        phase: random() * Math.PI * 2,
        layer: layerIndex,
        warm: random() < 0.16
      }))
    );
    const reduceMotion = prefersReducedMotion();
    let width = 0;
    let height = 0;
    let frame = 0;

    function resize() {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = Math.round(width * ratio);
      canvas!.height = Math.round(height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function draw(now: number) {
      const activeCamera = cameraRef.current;
      const pxPerUnit = frameSizeFor(width, height) / SIZE;
      const centerX = ((CENTER - activeCamera.x) / activeCamera.scale) * pxPerUnit;
      const centerY = ((CENTER - activeCamera.y) / activeCamera.scale) * pxPerUnit;

      const drift = reduceMotion ? 0 : now * 0.006;
      const seconds = now / 1000;
      context!.clearRect(0, 0, width, height);

      for (const star of stars) {
        const depth = STAR_LAYERS[star.layer].depth;
        const offsetX = centerX * depth * 1.2 + drift * depth * 10;
        const offsetY = centerY * depth * 1.2 + drift * depth * 4;
        const baseX = (((star.x - offsetX) % STAR_TILE) + STAR_TILE) % STAR_TILE;
        const baseY = (((star.y - offsetY) % STAR_TILE) + STAR_TILE) % STAR_TILE;
        const alpha = reduceMotion ? star.alpha : star.alpha * (0.62 + 0.38 * Math.sin(seconds * star.twinkle + star.phase));
        const color = star.warm ? `rgba(255, 216, 196, ${alpha.toFixed(3)})` : `rgba(226, 230, 255, ${alpha.toFixed(3)})`;

        for (let x = baseX; x < width; x += STAR_TILE) {
          for (let y = baseY; y < height; y += STAR_TILE) {
            context!.fillStyle = color;
            context!.beginPath();
            context!.arc(x, y, star.radius, 0, Math.PI * 2);
            context!.fill();

            if (star.layer === 2) {
              context!.fillStyle = star.warm ? `rgba(255, 190, 160, ${(alpha * 0.1).toFixed(3)})` : `rgba(190, 200, 255, ${(alpha * 0.1).toFixed(3)})`;
              context!.beginPath();
              context!.arc(x, y, star.radius * 4, 0, Math.PI * 2);
              context!.fill();
            }
          }
        }
      }

      frame = requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener("resize", resize);
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas aria-hidden="true" className="starfield" ref={canvasRef} />;
}

function formatFans(fans?: number) {
  if (!fans) {
    return "Deezer artist";
  }

  const compact = fans >= 1_000_000 ? `${(fans / 1_000_000).toFixed(fans >= 10_000_000 ? 0 : 1)}M` : fans >= 1000 ? `${(fans / 1000).toFixed(fans >= 10_000 ? 0 : 1)}K` : String(fans);
  return `${compact.replace(".0", "")} ${fans === 1 ? "fan" : "fans"}`;
}

const PREVIEW_VOLUME = 0.7;
const PREVIEW_FADE_IN_SECONDS = 1.4;
const PREVIEW_FADE_OUT_SECONDS = 0.9;
const PREVIEW_REFRESH_MARGIN_MS = 60 * 1000;
const SOUND_PREFERENCE_KEY = "recursive-app:sound";

type Deck = { audio: HTMLAudioElement; gain: GainNode };
type AudioLevels = { energy: number; bands: [number, number, number] };

function readSoundPreference() {
  try {
    return window.localStorage.getItem(SOUND_PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeSoundPreference(soundOn: boolean) {
  try {
    window.localStorage.setItem(SOUND_PREFERENCE_KEY, soundOn ? "on" : "off");
  } catch {
    // Private browsing can block storage; the toggle still works for this session.
  }
}

function previewExpiresSoon(url: string) {
  const match = /exp=(\d+)/.exec(url);
  return match ? Number(match[1]) * 1000 - Date.now() < PREVIEW_REFRESH_MARGIN_MS : false;
}

function setNodePreviews(tree: TreeState, nodeId: string, previews: TrackPreview[]) {
  const node = tree[nodeId];
  return node ? { ...tree, [nodeId]: { ...node, previews } } : tree;
}

// Two decks so one artist's preview can fade out while the next fades in. Audio runs through Web Audio:
// gain ramps work on iOS (which ignores element.volume), and the analyser drives the focused planet's
// pulse. Deezer serves previews with CORS headers, which Web Audio needs in order to hear them.
class PreviewEngine {
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private decks: Deck[] = [];
  private activeDeck = 0;
  private playToken = 0;
  private frequencies = new Uint8Array(0);

  // Browsers only allow audio after a user gesture, so this must run inside one.
  unlock() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        return false;
      }

      const context = new AudioContextClass();
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.8;
      analyser.connect(context.destination);
      this.decks = [0, 1].map(() => {
        const audio = new Audio();
        audio.crossOrigin = "anonymous";
        audio.preload = "auto";
        const gain = context.createGain();
        gain.gain.value = 0;
        context.createMediaElementSource(audio).connect(gain);
        gain.connect(analyser);
        return { audio, gain };
      });
      this.context = context;
      this.analyser = analyser;
      this.frequencies = new Uint8Array(analyser.frequencyBinCount);
    }

    void this.context.resume();
    return true;
  }

  async play(url: string, onEnded: () => void) {
    if (!this.context) {
      return false;
    }

    const token = ++this.playToken;
    this.fadeOut(this.decks[this.activeDeck]);
    this.activeDeck = 1 - this.activeDeck;
    const incoming = this.decks[this.activeDeck];
    this.ramp(incoming.gain, 0, 0);
    incoming.audio.onended = () => {
      if (token === this.playToken) {
        onEnded();
      }
    };
    incoming.audio.src = url;

    try {
      await incoming.audio.play();
    } catch {
      return false;
    }

    if (token !== this.playToken) {
      return false;
    }

    this.ramp(incoming.gain, PREVIEW_VOLUME, PREVIEW_FADE_IN_SECONDS);
    return true;
  }

  stop() {
    this.playToken += 1;
    this.decks.forEach((deck) => this.fadeOut(deck));
  }

  readLevels(): AudioLevels {
    if (!this.analyser) {
      return { energy: 0, bands: [0, 0, 0] };
    }

    this.analyser.getByteFrequencyData(this.frequencies);
    const average = (from: number, to: number) => {
      let total = 0;
      for (let index = from; index < to; index += 1) {
        total += this.frequencies[index] ?? 0;
      }
      return total / ((to - from) * 255);
    };
    const bands: [number, number, number] = [average(1, 4), average(4, 11), average(11, 24)];

    return { energy: bands[0] * 0.6 + bands[1] * 0.3 + bands[2] * 0.1, bands };
  }

  private fadeOut(deck: Deck | undefined) {
    if (!deck) {
      return;
    }

    this.ramp(deck.gain, 0, PREVIEW_FADE_OUT_SECONDS);
    const fadingSource = deck.audio.src;
    window.setTimeout(() => {
      // Only pause if this deck wasn't picked up again for a new track during the fade.
      if (deck.audio.src === fadingSource && deck.gain.gain.value < 0.01) {
        deck.audio.pause();
      }
    }, PREVIEW_FADE_OUT_SECONDS * 1000 + 60);
  }

  private ramp(gain: GainNode, target: number, seconds: number) {
    if (!this.context) {
      return;
    }

    const now = this.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(seconds === 0 ? target : gain.gain.value, now);
    if (seconds > 0) {
      gain.gain.linearRampToValueAtTime(target, now + seconds);
    }
  }
}

function SoundIcon({ muted }: { muted: boolean }) {
  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16">
      <path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor" />
      {muted ? (
        <path d="M11 6l3.5 4M14.5 6L11 10" stroke="currentColor" stroke-linecap="round" stroke-width="1.4" />
      ) : (
        <path d="M10.6 5.6a3.4 3.4 0 010 4.8M12.4 3.9a5.8 5.8 0 010 8.2" stroke="currentColor" stroke-linecap="round" stroke-width="1.4" />
      )}
    </svg>
  );
}

function routeTo(tree: TreeState, node: TreeNode) {
  const route: TreeNode[] = [];
  let current: TreeNode | undefined = node;

  while (current) {
    route.unshift(current);
    current = current.parentId ? tree[current.parentId] : undefined;
  }

  return route;
}

export function App() {
  const artistRoot = useQuery<ArtistNeighborhoodResult>("artistRoot");
  const searchArtists = useMutation<[term: string], ArtistSearchResult>("searchArtists");
  const loadRootArtist = useMutation<[artistId: string], ArtistNeighborhoodResult>("loadRootArtist");
  const loadRelatedArtists = useMutation<[artistId: string], ArtistNeighborhoodResult>("loadRelatedArtists");
  const loadArtistPreviews = useMutation<[artistId: string], ArtistPreviewsResult>("loadArtistPreviews");
  const [tree, setTree] = useState<TreeState>(() => createInitialTree());
  const [focusId, setFocusId] = useState(rootNode.id);
  const [cameraFocusId, setCameraFocusId] = useState(rootNode.id);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [coreArtistId, setCoreArtistId] = useState(kendrickLamarFallback.id);
  const [artistSearchText, setArtistSearchText] = useState("");
  const [artistSearchResults, setArtistSearchResults] = useState<ArtistSummary[]>([]);
  const [artistSearchStatus, setArtistSearchStatus] = useState<SearchStatus>("idle");
  const [artistSearchError, setArtistSearchError] = useState<string | undefined>();
  const [isArtistPickerOpen, setIsArtistPickerOpen] = useState(false);
  const [rootLoadId, setRootLoadId] = useState<string | undefined>();
  const treeRef = useRef(tree);
  const pendingLoadsRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const preloadFocusRef = useRef<string>();
  const requestQueueRef = useRef<Promise<void>>(Promise.resolve());
  const neighborhoodRequestsRef = useRef<Map<string, { promise: Promise<ArtistNeighborhoodResult>; start: () => void }>>(new Map());
  const [hoveredId, setHoveredId] = useState<string | undefined>();
  const searchRequestIdRef = useRef(0);
  const rootLoadRequestIdRef = useRef(0);
  const artistSearchInputRef = useRef<HTMLInputElement>(null);
  const artistPickerRef = useRef<HTMLFormElement>(null);
  const keyboardHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const focusedNode = tree[focusId] ?? rootNode;
  const cameraFocusedNode = tree[cameraFocusId] ?? focusedNode;
  const isTraveling = focusId !== cameraFocusId;
  const roles = useMemo(() => buildNodeRoles(tree, focusedNode), [tree, focusedNode]);
  const edges = useMemo(() => buildEdges(tree, roles), [tree, roles]);
  const previewEdges = useMemo(() => buildProjectedPreviewEdges(tree, focusedNode), [tree, focusedNode]);
  const orbitRings = useMemo(() => buildOrbitRings(tree, focusedNode), [tree, focusedNode]);
  const targetCamera = useMemo(() => cameraFor(tree, cameraFocusedNode), [tree, cameraFocusedNode]);
  const camera = useAnimatedCamera(targetCamera, () => setFocusId(cameraFocusId));
  const loadedNodes = useMemo(() => Object.values(tree).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)), [tree]);
  const trimmedArtistSearchText = artistSearchText.trim();
  const showArtistSearchPanel =
    isArtistPickerOpen && (trimmedArtistSearchText.length >= 2 || artistSearchResults.length > 0 || artistSearchStatus !== "idle" || Boolean(artistSearchError));
  const renderedNodes = loadedNodes;
  const tintFor = useTints(renderedNodes.map((node) => node.imageUrl).filter((url): url is string => Boolean(url)));
  const route = useMemo(() => routeTo(tree, cameraFocusedNode), [tree, cameraFocusedNode]);
  const aura = cameraFocusedNode.imageUrl ? tintFor(cameraFocusedNode.imageUrl) : DEFAULT_TINT;
  const cameraDriftX = (CENTER - camera.x) / camera.scale - CENTER;
  const cameraDriftY = (CENTER - camera.y) / camera.scale - CENTER;
  const engineRef = useRef<PreviewEngine>();
  const cosmosRef = useRef<HTMLElement>(null);
  const refreshedPreviewsRef = useRef(new Set<string>());
  const [soundOn, setSoundOn] = useState(readSoundPreference);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<string | undefined>();
  const [previewRefreshCount, setPreviewRefreshCount] = useState(0);
  const playingNode = cameraFocusedNode;
  const playingPreviews = playingNode.previews;
  // Keyed by URL so an identical list arriving again (e.g. a re-sent query) doesn't restart the track.
  const playingPreviewsKey = playingPreviews ? playingPreviews.map((preview) => preview.url).join("|") : undefined;

  if (!engineRef.current) {
    engineRef.current = new PreviewEngine();
  }

  useEffect(() => {
    installIcons();
  }, []);

  useEffect(() => {
    if (!showShortcuts) {
      return;
    }

    function closeShortcuts() {
      setShowShortcuts(false);
    }

    document.addEventListener("pointerdown", closeShortcuts);

    return () => {
      document.removeEventListener("pointerdown", closeShortcuts);
    };
  }, [showShortcuts]);

  // Close the search results when a click lands anywhere outside the search box.
  useEffect(() => {
    if (!isArtistPickerOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!artistPickerRef.current?.contains(event.target as Node)) {
        setIsArtistPickerOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isArtistPickerOpen]);

  // The tab names the artist you're orbiting, so it tells you where you are.
  useEffect(() => {
    document.title = `${cameraFocusedNode.label} · ${APP_NAME}`;
  }, [cameraFocusedNode.label]);

  // The first click or key press anywhere unlocks audio; until then browsers keep the page silent.
  useEffect(() => {
    function unlockAudio() {
      if (engineRef.current?.unlock()) {
        setAudioUnlocked(true);
        window.removeEventListener("pointerdown", unlockAudio);
        window.removeEventListener("keydown", unlockAudio);
      }
    }

    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);

    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  // Music follows the camera: as you fly to an artist, the old preview fades out and theirs fades in.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !soundOn || !audioUnlocked || !playingPreviews || playingPreviews.length === 0) {
      engine?.stop();
      setNowPlaying(undefined);
      return;
    }

    const refreshKey = `${playingNode.id}:${playingPreviews[0]?.url}`;
    if (playingPreviews.some((preview) => previewExpiresSoon(preview.url)) && !refreshedPreviewsRef.current.has(refreshKey)) {
      refreshedPreviewsRef.current.add(refreshKey);
      engine.stop();
      setNowPlaying(undefined);
      const nodeId = playingNode.id;
      void loadArtistPreviews(playingNode.artistId)
        .then((result) => {
          if (result.ok) {
            setTree((currentTree) => setNodePreviews(currentTree, nodeId, result.data));
          }
        })
        .catch(() => undefined)
        // Retry playback either way: the refresh can come back with the same, still-valid URLs.
        .finally(() => setPreviewRefreshCount((count) => count + 1));
      return;
    }

    let cancelled = false;

    function playTrack(index: number, failures: number) {
      const tracks = playingPreviews ?? [];
      const track = tracks[index % tracks.length];
      if (!track || cancelled) {
        return;
      }

      setNowPlaying(track.title);
      void engine!
        .play(track.url, () => {
          if (!cancelled) {
            playTrack(index + 1, 0);
          }
        })
        .then((started) => {
          if (!started && !cancelled) {
            // Skip a clip that won't load; give up quietly once every clip has failed.
            if (failures + 1 < tracks.length) {
              playTrack(index + 1, failures + 1);
            } else {
              setNowPlaying(undefined);
            }
          }
        });
    }

    playTrack(0, 0);

    return () => {
      cancelled = true;
    };
  }, [playingNode.id, playingPreviewsKey, soundOn, audioUnlocked, previewRefreshCount]);

  // The focused planet's corona breathes with the music's low end.
  useEffect(() => {
    const element = cosmosRef.current;
    if (!element || !nowPlaying || prefersReducedMotion()) {
      element?.style.setProperty("--beat", "0");
      return;
    }

    let frame = 0;
    let energyAverage: number | undefined;
    let pulse = 0;
    const bandAverages: (number | undefined)[] = [undefined, undefined, undefined];
    const clamp = (value: number) => Math.min(1, Math.max(0, value));

    // Loud masters sit at a nearly constant level, so react to how far each frame rises above the
    // recent average: a quick kick on each beat that decays, instead of a glow stuck at one size.
    function tick() {
      const levels = engineRef.current?.readLevels();
      if (levels && element) {
        energyAverage = energyAverage === undefined ? levels.energy : energyAverage * 0.96 + levels.energy * 0.04;
        pulse = Math.max(clamp((levels.energy - energyAverage) * 6), pulse * 0.88);
        element.style.setProperty("--beat", pulse.toFixed(3));
        levels.bands.forEach((band, index) => {
          const average = bandAverages[index];
          const nextAverage = average === undefined ? band : average * 0.94 + band * 0.06;
          bandAverages[index] = nextAverage;
          element.style.setProperty(`--band-${index}`, clamp(0.35 + (band - nextAverage) * 5).toFixed(3));
        });
      }

      frame = requestAnimationFrame(tick);
    }

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      element.style.setProperty("--beat", "0");
      [0, 1, 2].forEach((index) => element.style.setProperty(`--band-${index}`, "0"));
    };
  }, [nowPlaying]);

  function handleSoundPointerDown(event: PointerEvent) {
    // Handle unlocking here so the window listener doesn't also treat this press as a toggle.
    event.stopPropagation();
  }

  function handleSoundClick() {
    if (!audioUnlocked) {
      if (engineRef.current?.unlock()) {
        setAudioUnlocked(true);
      }

      setSoundOn(true);
      writeSoundPreference(true);
      return;
    }

    setSoundOn((current) => {
      writeSoundPreference(!current);
      return !current;
    });
  }

  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      keyboardHandlerRef.current(event);
    }

    window.addEventListener("keydown", handleGlobalKeyDown);

    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);

  useEffect(() => {
    const term = artistSearchText.trim();

    if (!isArtistPickerOpen || term.length < 2) {
      setArtistSearchStatus("idle");
      setArtistSearchError(undefined);
      setArtistSearchResults([]);
      return;
    }

    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setArtistSearchStatus("searching");
    setArtistSearchError(undefined);

    const timeout = setTimeout(() => {
      void (async () => {
        let result: ArtistSearchResult;
        try {
          result = await searchArtists(term);
        } catch (error) {
          result = {
            ok: false,
            error: error instanceof Error ? error.message : "Unable to search Deezer artists."
          };
        }

        if (searchRequestIdRef.current !== requestId) {
          return;
        }

        if (!result.ok) {
          setArtistSearchStatus("error");
          setArtistSearchError(result.error);
          setArtistSearchResults([]);
          return;
        }

        setArtistSearchStatus("idle");
        setArtistSearchResults(result.data);
      })();
    }, 320);

    return () => {
      clearTimeout(timeout);
    };
  }, [artistSearchText, isArtistPickerOpen]);

  useEffect(() => {
    if (!artistRoot) {
      return;
    }

    if (coreArtistId !== kendrickLamarFallback.id) {
      return;
    }

    if (!artistRoot.ok) {
      setLoadError(artistRoot.error);
      setTree((currentTree) => setNodeChildrenStatus(currentTree, rootNode.id, "error", artistRoot.error));
      return;
    }

    setLoadError(undefined);
    setTree((currentTree) => attachChildren(updateNodeArtist(currentTree, rootNode.id, artistRoot.data), rootNode.id, artistRoot.data.related));
  }, [artistRoot, coreArtistId]);

  useEffect(() => {
    if (isTraveling) {
      return;
    }

    if (preloadFocusRef.current === focusedNode.id) {
      return;
    }

    // Prefetch every orbiting artist so a click almost never waits on the network.
    const candidates = getChildren(tree, focusedNode).filter((node) => node.childrenStatus === "idle");
    if (candidates.length === 0) {
      return;
    }

    preloadFocusRef.current = focusedNode.id;
    for (const candidate of candidates) {
      void loadNodeNeighborhood(candidate.id, { showError: false, showLoading: false });
    }
  }, [tree, focusedNode, isTraveling]);

  // Background loads run one at a time; a priority request (hover or click) starts immediately and the
  // queue simply reuses its result when that artist's turn comes up.
  function requestNeighborhood(artistId: string, priority: boolean) {
    let entry = neighborhoodRequestsRef.current.get(artistId);

    if (!entry) {
      let started = false;
      let start = () => {};
      const promise = new Promise<ArtistNeighborhoodResult>((resolve) => {
        start = () => {
          if (started) {
            return;
          }

          started = true;
          loadRelatedArtists(artistId).then(resolve, (error: unknown) =>
            resolve({
              ok: false,
              error: error instanceof Error ? error.message : "Unable to load artist data from Deezer."
            })
          );
        };
      });
      const createdEntry = { promise, start };
      entry = createdEntry;
      neighborhoodRequestsRef.current.set(artistId, createdEntry);
      void promise.then(() => {
        if (neighborhoodRequestsRef.current.get(artistId) === createdEntry) {
          neighborhoodRequestsRef.current.delete(artistId);
        }
      });

      requestQueueRef.current = requestQueueRef.current
        .then(() => delay(LOAD_THROTTLE_MS))
        .then(() => {
          createdEntry.start();
          return createdEntry.promise;
        })
        .then(() => undefined);
    }

    if (priority) {
      entry.start();
    }

    return entry.promise;
  }

  function handleNodeHover(nodeId: string) {
    setHoveredId(nodeId);
    void loadNodeNeighborhood(nodeId, { showError: false, showLoading: false, priority: true });
  }

  async function loadNodeNeighborhood(nodeId: string, options: { showError: boolean; showLoading: boolean; priority?: boolean }) {
    const node = treeRef.current[nodeId];
    if (!node) {
      return false;
    }

    if (node.childrenStatus === "loaded") {
      return true;
    }

    const pendingLoad = pendingLoadsRef.current.get(nodeId);
    if (pendingLoad) {
      if (options.priority) {
        requestNeighborhood(node.artistId, true);
      }

      if (options.showLoading) {
        setTree((currentTree) => setNodeChildrenStatus(currentTree, nodeId, "loading"));
      }

      return pendingLoad;
    }

    if (options.showError) {
      setLoadError(undefined);
    }

    if (options.showLoading) {
      setTree((currentTree) => setNodeChildrenStatus(currentTree, nodeId, "loading"));
    }

    const loadPromise = (async () => {
      const result = await requestNeighborhood(node.artistId, Boolean(options.priority));

      if (!result.ok) {
        if (options.showError) {
          setLoadError(result.error);
        }

        setTree((currentTree) => setNodeChildrenStatus(currentTree, nodeId, "error", result.error));
        return false;
      }

      if (options.showError) {
        setLoadError(undefined);
      }

      setTree((currentTree) => attachChildren(updateNodeArtist(currentTree, nodeId, result.data), nodeId, result.data.related));
      return true;
    })();

    pendingLoadsRef.current.set(nodeId, loadPromise);

    try {
      return await loadPromise;
    } finally {
      pendingLoadsRef.current.delete(nodeId);
    }
  }

  function focusNode(nodeId: string) {
    const node = tree[nodeId];
    if (!node || isTraveling) {
      return;
    }

    if (nodeId === cameraFocusId) {
      if (node.childrenStatus === "error") {
        void loadNodeNeighborhood(nodeId, { showError: true, showLoading: true, priority: true });
      }

      return;
    }

    // Start flying right away; the flight itself covers most of the load time.
    void loadNodeNeighborhood(nodeId, { showError: true, showLoading: true, priority: true });
    setHoveredId(undefined);
    setCameraFocusId(nodeId);
  }

  function handleArtistSearchSubmit(event: SubmitEvent) {
    event.preventDefault();
    const firstArtist = artistSearchResults[0];

    if (firstArtist) {
      void chooseCoreArtist(firstArtist);
    }
  }

  function focusArtistSearchInput(options: { selectText?: boolean } = {}) {
    setIsArtistPickerOpen(true);

    requestAnimationFrame(() => {
      artistSearchInputRef.current?.focus();

      if (options.selectText) {
        artistSearchInputRef.current?.select();
      }
    });
  }

  function handleArtistSearchKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      setIsArtistPickerOpen(false);
      artistSearchInputRef.current?.blur();
    }
  }

  async function chooseCoreArtist(artist: ArtistSummary) {
    const requestId = rootLoadRequestIdRef.current + 1;
    rootLoadRequestIdRef.current = requestId;
    pendingLoadsRef.current.clear();
    neighborhoodRequestsRef.current.clear();
    setHoveredId(undefined);
    preloadFocusRef.current = undefined;
    requestQueueRef.current = Promise.resolve();
    searchRequestIdRef.current += 1;

    const loadingCore = makeRootNode(artist, "loading");
    setCoreArtistId(artist.id);
    setArtistSearchText(artist.name);
    setArtistSearchResults([]);
    setArtistSearchStatus("idle");
    setArtistSearchError(undefined);
    setIsArtistPickerOpen(false);
    artistSearchInputRef.current?.blur();
    setRootLoadId(artist.id);
    setLoadError(undefined);
    setFocusId(rootNode.id);
    setCameraFocusId(rootNode.id);
    setTree({ [loadingCore.id]: loadingCore });

    let result: ArtistNeighborhoodResult;
    try {
      result = await loadRootArtist(artist.id);
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to load artist data from Deezer."
      };
    }

    if (rootLoadRequestIdRef.current !== requestId) {
      return;
    }

    setRootLoadId(undefined);

    if (!result.ok) {
      setLoadError(result.error);
      setTree((currentTree) => setNodeChildrenStatus(currentTree, rootNode.id, "error", result.error));
      return;
    }

    setLoadError(undefined);
    setCoreArtistId(result.data.artist.id);
    setTree((currentTree) => attachChildren(updateNodeArtist(currentTree, rootNode.id, result.data), rootNode.id, result.data.related));
  }

  function planetButton(nodeId: string) {
    return document.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
  }

  // Spatial navigation: from the highlighted planet (or the focused artist), move to the nearest
  // orbiting artist in the arrow's direction, wrapping to the far side when nothing is left that way.
  function moveSelection(direction: { x: number; y: number }) {
    const children = getChildren(tree, focusedNode);
    const activeId = (document.activeElement as HTMLElement | null)?.dataset?.nodeId;
    const current = children.find((child) => child.id === activeId);
    const origin = current ?? focusedNode;
    const candidates = children.filter((child) => child.id !== current?.id);
    const along = (node: TreeNode) => (node.x - origin.x) * direction.x + (node.y - origin.y) * direction.y;
    let best: TreeNode | undefined;
    let bestScore = Infinity;

    for (const candidate of candidates) {
      const forward = along(candidate);
      if (forward <= 0) {
        continue;
      }

      const sideways = Math.abs((candidate.x - origin.x) * direction.y - (candidate.y - origin.y) * direction.x);
      const score = forward + sideways * 2;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    best ??= candidates.reduce<TreeNode | undefined>((farthest, candidate) => (!farthest || along(candidate) < along(farthest) ? candidate : farthest), undefined);
    if (best) {
      planetButton(best.id)?.focus();
    }
  }

  function handleSearchKeys(event: KeyboardEvent) {
    const picker = artistPickerRef.current;
    if (!picker) {
      return;
    }

    if (event.key === "Escape" && event.target !== artistSearchInputRef.current) {
      setIsArtistPickerOpen(false);
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    const items = [artistSearchInputRef.current, ...Array.from(picker.querySelectorAll<HTMLButtonElement>(".artist-search-result:not(:disabled)"))].filter(
      (item): item is HTMLInputElement | HTMLButtonElement => Boolean(item)
    );
    const index = items.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement);
    if (index === -1 || items.length < 2) {
      return;
    }

    event.preventDefault();
    items[event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1)]?.focus();
  }

  keyboardHandlerRef.current = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      focusArtistSearchInput({ selectText: true });
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target && artistPickerRef.current?.contains(target)) {
      handleSearchKeys(event);
      return;
    }

    if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") {
      return;
    }

    const arrows: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 }
    };
    const arrow = arrows[event.key];

    if (arrow) {
      event.preventDefault();
      if (!isTraveling) {
        moveSelection(arrow);
      }
    } else if (/^[1-9]$/.test(event.key)) {
      const ordered = [...getChildren(tree, focusedNode)].sort((first, second) => first.x - second.x);
      const destination = ordered[Number(event.key) - 1];
      if (destination) {
        event.preventDefault();
        focusNode(destination.id);
      }
    } else if (event.key === "Backspace") {
      if (focusedNode.parentId) {
        event.preventDefault();
        focusNode(focusedNode.parentId);
      }
    } else if (event.key === "m" || event.key === "M") {
      handleSoundClick();
    } else if (event.key === "/") {
      event.preventDefault();
      focusArtistSearchInput();
    } else if (event.key === "?") {
      setShowShortcuts((current) => !current);
    } else if (event.key === "Escape") {
      if (showShortcuts) {
        setShowShortcuts(false);
      } else {
        (document.activeElement as HTMLElement | null)?.blur();
      }
    }
  };

  function renderArtistNode(node: TreeNode, role: NodeRole, radius: number, cameraScale: number, options: { interactive: boolean }) {
    const isFocus = role === "focus";
    const isReachable = isInteractiveRole(role);
    const lines = isFocus ? [node.label] : labelLines(node.label);
    const isLoading = node.childrenStatus === "loading";
    const parent = node.parentId ? tree[node.parentId] : undefined;
    const worldDiameter = (radius / cameraScale) * 2;
    const style = {
      ...nodeStyle(node, radius, cameraScale),
      "--planet": node.imageUrl ? tintFor(node.imageUrl) : DEFAULT_TINT,
      "--emerge-x": parent ? `${(((parent.x - node.x) / worldDiameter) * 100).toFixed(1)}%` : "0%",
      "--emerge-y": parent ? `${(((parent.y - node.y) / worldDiameter) * 100).toFixed(1)}%` : "0%"
    };

    // The node you came from often sits right under the focused name, so its label moves beside it.
    const labelSide = role === "parent" && node.y > focusedNode.y + 40;
    const canHover = role === "child" || role === "parent" || role === "ancestor";
    const isRetry = isFocus && node.childrenStatus === "error";

    return (
      <div
        aria-hidden={isReachable ? undefined : "true"}
        className={`${nodeClassName(role, node.childrenStatus)}${labelSide ? " node-label-side" : ""}`}
        key={node.id}
        onPointerEnter={canHover ? () => handleNodeHover(node.id) : undefined}
        onPointerLeave={canHover ? () => setHoveredId((current) => (current === node.id ? undefined : current)) : undefined}
        style={style}
      >
        <div className="node-emerge">
          <div className="node-float">
            {isFocus ? <span aria-hidden="true" className="corona" /> : null}
            <button
              aria-label={isRetry ? `Retry loading artists related to ${node.label}` : isFocus ? `${node.label}, you are here` : `Travel to ${node.label}`}
              className="planet"
              data-node-id={node.id}
              disabled={!options.interactive}
              onBlur={canHover ? () => setHoveredId((current) => (current === node.id ? undefined : current)) : undefined}
              onClick={options.interactive ? () => focusNode(node.id) : undefined}
              onFocus={canHover ? () => handleNodeHover(node.id) : undefined}
              tabIndex={isReachable ? undefined : -1}
              type="button"
            >
              {node.imageUrl ? (
                <>
                  <img alt="" className="planet-image" crossOrigin="anonymous" draggable={false} src={node.imageUrl} />
                  <span aria-hidden="true" className="planet-shade" />
                </>
              ) : (
                <VinylRecord />
              )}
            </button>
            {isLoading ? (
              <span aria-hidden="true" className="satellite-orbit">
                <span className="satellite" />
              </span>
            ) : null}
            <span aria-hidden="true" className="node-name">
              {lines.map((line) => (
                <span key={`${node.id}-${line}`}>{line}</span>
              ))}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const jumps = route.length - 1;
  const isDeadEnd = cameraFocusedNode.childrenStatus === "loaded" && getChildren(tree, cameraFocusedNode).length === 0;
  const visibleRoute = route.length > 5 ? [route[0], undefined, ...route.slice(-3)] : route;

  return (
    <main className="cosmos" ref={cosmosRef} style={{ "--aura": aura, "--aura-2": shiftHue(aura, 46) } as Record<string, string>}>
      <style>{`
        @import url("https://api.fontshare.com/v2/css?f[]=clash-display@500,600&f[]=satoshi@500,700&display=swap");
        @import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap");

        @property --aura {
          syntax: "<color>";
          inherits: true;
          initial-value: hsl(42 48% 74%);
        }

        @property --aura-2 {
          syntax: "<color>";
          inherits: true;
          initial-value: hsl(42 48% 74%);
        }

        :root {
          --void: #04040b;
          --ink: #eeeaf8;
          --dust: #8e8ba8;
          --ember: #ffb08a;
          --ease-graph: cubic-bezier(0.22, 1, 0.36, 1);
          --font-display: "Clash Display", ui-sans-serif, system-ui, sans-serif;
          --font-ui: Satoshi, ui-sans-serif, system-ui, -apple-system, sans-serif;
          --font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
          --fog-mask: radial-gradient(
            circle closest-side at 50% 50%,
            #000 0%,
            #000 64%,
            rgba(0, 0, 0, 0.92) 76%,
            rgba(0, 0, 0, 0.6) 86%,
            rgba(0, 0, 0, 0.24) 94%,
            transparent 100%
          );
          color-scheme: dark;
        }

        body {
          margin: 0;
          background: var(--void);
        }

        .cosmos {
          min-height: 100vh;
          min-height: 100dvh;
          position: relative;
          overflow: hidden;
          isolation: isolate;
          background: radial-gradient(120% 90% at 50% 42%, #0b0a1d 0%, var(--void) 62%);
          color: var(--ink);
          font-family: var(--font-ui);
          -webkit-font-smoothing: antialiased;
          transition:
            --aura 1.8s ease,
            --aura-2 1.8s ease;
        }

        .starfield {
          width: 100%;
          height: 100%;
          position: fixed;
          inset: 0;
          z-index: 0;
          pointer-events: none;
        }

        .nebula {
          position: fixed;
          inset: -25%;
          z-index: 0;
          pointer-events: none;
          background:
            radial-gradient(28% 24% at 50% 50%, color-mix(in oklab, var(--aura) 22%, transparent), transparent 72%),
            radial-gradient(24% 20% at 60% 40%, color-mix(in oklab, var(--aura-2) 14%, transparent), transparent 70%),
            radial-gradient(30% 22% at 38% 62%, color-mix(in oklab, var(--aura) 10%, transparent), transparent 72%),
            radial-gradient(18% 14% at 68% 66%, color-mix(in oklab, var(--aura-2) 8%, transparent), transparent 70%);
          filter: blur(36px);
          animation: nebula-breathe 22s ease-in-out infinite alternate;
          will-change: transform;
        }

        .fog {
          position: fixed;
          inset: 0;
          z-index: 3;
          pointer-events: none;
          background: radial-gradient(ellipse 72% 80% at 50% 50%, transparent 58%, rgba(4, 4, 11, 0.5) 86%, rgba(4, 4, 11, 0.88) 100%);
        }

        .graph-stage {
          min-height: 100vh;
          min-height: 100dvh;
          position: relative;
          z-index: 1;
          display: grid;
          place-items: center;
          box-sizing: border-box;
          padding-bottom: 56px;
        }

        .graph-frame {
          width: min(94vmin, calc(100vw - 24px), 960px);
          aspect-ratio: 1;
          position: relative;
          isolation: isolate;
          overflow: hidden;
        }

        .graph-svg,
        .node-html-layer {
          position: absolute;
          inset: 0;
          -webkit-mask-image: var(--fog-mask);
          mask-image: var(--fog-mask);
        }

        .graph-svg {
          z-index: 1;
          width: 100%;
          height: 100%;
          display: block;
          overflow: visible;
          pointer-events: none;
        }

        .node-html-layer {
          z-index: 2;
          pointer-events: none;
        }

        .node-world {
          position: absolute;
          inset: 0;
          transform-origin: 0 0;
          will-change: transform;
        }

        .orbit-ring {
          fill: none;
          stroke-linecap: round;
          vector-effect: non-scaling-stroke;
          transform-box: fill-box;
          transform-origin: center;
          animation: orbit-spin 150s linear infinite;
          transition:
            opacity 400ms ease,
            stroke 900ms ease;
        }

        .orbit-ring-next {
          stroke: color-mix(in oklab, var(--aura) 55%, transparent);
          stroke-width: 1.3;
          stroke-dasharray: 2 8;
        }

        .orbit-ring-current {
          stroke: rgba(200, 204, 235, 0.26);
          stroke-width: 1.1;
          stroke-dasharray: 1.5 9;
        }

        .orbit-ring-inner {
          stroke: rgba(200, 204, 235, 0.15);
          stroke-width: 1;
          stroke-dasharray: 1 10;
        }

        .orbit-ring-horizon {
          stroke: rgba(200, 204, 235, 0.11);
          stroke-width: 1;
          stroke-dasharray: 1 12;
        }

        .edge {
          fill: none;
          stroke-width: 1.2;
          stroke-linecap: round;
          vector-effect: non-scaling-stroke;
          transition:
            opacity 400ms ease,
            stroke 400ms ease;
        }

        .edge-child {
          stroke: color-mix(in oklab, var(--aura) 46%, transparent);
        }

        .edge-parent {
          stroke: color-mix(in oklab, var(--ember) 52%, transparent);
          stroke-width: 1.4;
        }

        .edge-preview {
          stroke: rgba(200, 204, 235, 0.3);
          stroke-dasharray: 0.5 7;
          stroke-width: 1.6;
        }

        .edge-preview-lit {
          stroke: color-mix(in oklab, var(--aura) 60%, transparent);
        }

        .edge-route {
          stroke: color-mix(in oklab, var(--ember) 24%, transparent);
          stroke-dasharray: 3 6;
        }

        .node {
          position: absolute;
          pointer-events: auto;
          transform: translate(-50%, -50%);
          transform-origin: 50% 50%;
          transition:
            width 520ms var(--ease-graph),
            height 520ms var(--ease-graph),
            opacity 420ms ease,
            transform 260ms var(--ease-graph);
        }

        .node-emerge {
          width: 100%;
          height: 100%;
          animation: node-emerge 1200ms var(--ease-graph) both;
        }

        .node-float {
          width: 100%;
          height: 100%;
          position: relative;
          animation: node-drift var(--node-drift-duration) ease-in-out infinite;
          animation-delay: var(--node-drift-delay);
          will-change: transform;
        }

        .node-button {
          cursor: pointer;
        }

        .node-button:hover {
          transform: translate(-50%, -50%) scale(1.07);
        }

        .node-button:active {
          transform: translate(-50%, -50%) scale(0.97);
        }

        .node-focus {
          cursor: default;
        }

        .node-focus:hover,
        .node-focus:active {
          transform: translate(-50%, -50%);
        }

        .corona {
          position: absolute;
          inset: -70%;
          z-index: 0;
          border-radius: 50%;
          pointer-events: none;
          background: radial-gradient(
            circle closest-side,
            color-mix(in oklab, var(--planet) 38%, transparent) 30%,
            color-mix(in oklab, var(--planet) 12%, transparent) 58%,
            transparent 100%
          );
          animation: corona-breathe 8s ease-in-out infinite;
          scale: calc(1 + var(--beat, 0) * 0.3);
        }

        .planet {
          width: 100%;
          height: 100%;
          position: relative;
          z-index: 1;
          display: grid;
          place-items: center;
          overflow: hidden;
          box-sizing: border-box;
          padding: 0;
          border: 0;
          border-radius: 50%;
          appearance: none;
          background: radial-gradient(circle at 34% 30%, #2b2944, #0b0a17 72%);
          color: var(--ink);
          cursor: inherit;
          box-shadow:
            0 0 0 1px rgba(238, 234, 248, 0.1),
            0 0 22px -4px color-mix(in oklab, var(--planet) 60%, transparent),
            0 14px 30px rgba(0, 0, 0, 0.55);
          transition:
            box-shadow 520ms var(--ease-graph),
            filter 420ms ease;
        }

        .planet:focus {
          outline: none;
        }

        .planet:focus-visible {
          outline: 1.5px solid var(--planet);
          outline-offset: 7px;
        }

        .planet-image {
          width: 100%;
          height: 100%;
          display: block;
          pointer-events: none;
          object-fit: cover;
          border-radius: 50%;
          transition: filter 420ms ease;
        }

        .vinyl {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          pointer-events: none;
          background:
            radial-gradient(circle, transparent 0 30%, rgba(255, 255, 255, 0.03) 30.5% 31%, transparent 31.5%),
            repeating-radial-gradient(circle, #111116 0 1.2%, #15151b 1.2% 2.1%),
            #0f0f14;
          box-shadow: inset 0 0 0 1px rgba(238, 234, 248, 0.06);
        }

        .vinyl-label {
          position: absolute;
          inset: 34%;
          border-radius: 50%;
          background: radial-gradient(circle, #121214 0 9%, transparent 10%), #535358;
          box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
          animation: node-spin 5s linear infinite;
        }

        .vinyl-label::after {
          content: "";
          position: absolute;
          inset: 18%;
          border: 1.5px solid transparent;
          border-top-color: rgba(255, 255, 255, 0.22);
          border-radius: 50%;
          transform: rotate(-30deg);
        }

        .vinyl-sheen {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: conic-gradient(from 20deg, transparent 0 10%, rgba(255, 255, 255, 0.07) 14%, transparent 20% 50%, rgba(255, 255, 255, 0.05) 64%, transparent 70%);
        }

        .planet-shade {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          pointer-events: none;
          background:
            radial-gradient(circle at 30% 24%, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0) 38%),
            radial-gradient(circle at 60% 64%, rgba(4, 4, 11, 0) 48%, rgba(4, 4, 11, 0.5) 92%);
          box-shadow:
            inset 0 0 0 1px color-mix(in oklab, var(--planet) 36%, transparent),
            inset 2px 3px 8px -3px color-mix(in oklab, var(--planet) 70%, transparent);
        }

        .node-focus .planet {
          box-shadow:
            0 0 0 1px rgba(238, 234, 248, 0.18),
            0 0 0 7px color-mix(in oklab, var(--planet) 10%, transparent),
            0 0 70px 6px color-mix(in oklab, var(--planet) 42%, transparent),
            0 18px 40px rgba(0, 0, 0, 0.6);
        }

        .node-child:hover .planet,
        .node-child .planet:focus-visible {
          box-shadow:
            0 0 0 1px rgba(238, 234, 248, 0.22),
            0 0 36px 2px color-mix(in oklab, var(--planet) 70%, transparent),
            0 14px 30px rgba(0, 0, 0, 0.55);
        }

        .node-parent .planet-shade {
          box-shadow:
            inset 0 0 0 1px color-mix(in oklab, var(--ember) 60%, transparent),
            inset 2px 3px 8px -3px color-mix(in oklab, var(--ember) 70%, transparent);
        }

        .node-parent .planet {
          box-shadow:
            0 0 0 1px rgba(238, 234, 248, 0.08),
            0 0 22px -4px color-mix(in oklab, var(--ember) 50%, transparent),
            0 14px 30px rgba(0, 0, 0, 0.55);
        }

        .node-ancestor {
          opacity: 0.5;
        }

        .node-ancestor:hover {
          opacity: 0.9;
        }

        .node-ancestor .planet-image {
          filter: grayscale(0.7) brightness(0.8);
        }

        .node-ghost {
          pointer-events: none;
          opacity: 0;
        }

        .node-focus .planet:not(:disabled) {
          cursor: pointer;
        }

        .satellite-orbit {
          position: absolute;
          inset: -14%;
          z-index: 2;
          border-radius: 50%;
          pointer-events: none;
          border: 1px solid color-mix(in oklab, var(--planet) 26%, transparent);
          animation: node-spin 1.3s linear infinite;
        }

        .satellite {
          width: 6px;
          height: 6px;
          position: absolute;
          top: -3.5px;
          left: calc(50% - 3px);
          border-radius: 50%;
          background: var(--ink);
          box-shadow: 0 0 10px 2px color-mix(in oklab, var(--planet) 80%, transparent);
        }

        .node-name {
          width: 240%;
          position: absolute;
          top: calc(100% + 12px);
          left: 50%;
          z-index: 1;
          display: grid;
          gap: 1px;
          pointer-events: none;
          transform: translateX(-50%) scale(var(--node-text-scale));
          transform-origin: top center;
          color: rgba(238, 234, 248, 0.78);
          font: 500 12.5px/1.15 var(--font-ui);
          letter-spacing: 0.01em;
          text-align: center;
          text-shadow: 0 1px 12px rgba(4, 4, 11, 0.95);
          transition:
            color 300ms ease,
            transform 520ms var(--ease-graph);
        }

        .node-focus .node-name {
          width: 340%;
          top: calc(100% + 16px);
          color: var(--ink);
          font: 500 36px/1 var(--font-display);
          letter-spacing: -0.01em;
          text-wrap: balance;
          text-shadow: 0 2px 24px rgba(4, 4, 11, 0.9);
        }

        .node-child .node-name {
          color: rgba(238, 234, 248, 0.86);
        }

        .node-label-side .node-name {
          width: max-content;
          top: 50%;
          left: calc(100% + 12px);
          transform: translateY(-50%) scale(var(--node-text-scale));
          transform-origin: left center;
          text-align: left;
        }

        .node-child:hover .node-name,
        .node-child:has(.planet:focus-visible) .node-name {
          color: #fff;
        }

        .node-button:has(.planet:focus-visible) {
          transform: translate(-50%, -50%) scale(1.07);
        }

        .hud-key {
          display: inline-block;
          min-width: 1.4em;
          padding: 2px 6px;
          border: 1px solid rgba(238, 234, 248, 0.16);
          border-radius: 6px;
          background: rgba(238, 234, 248, 0.05);
          color: var(--ink);
          font: 500 10.5px/1.3 var(--font-mono);
          text-align: center;
          white-space: pre;
        }

        .shortcuts {
          width: min(440px, calc(100vw - 32px));
          position: fixed;
          bottom: calc(max(24px, env(safe-area-inset-bottom)) + 62px);
          left: 50%;
          z-index: 7;
          box-sizing: border-box;
          padding: 16px 18px 12px;
          border: 1px solid rgba(238, 234, 248, 0.1);
          border-radius: 22px;
          background: rgba(9, 9, 24, 0.86);
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
          transform: translateX(-50%);
          backdrop-filter: blur(20px) saturate(1.2);
          animation: panel-rise 220ms var(--ease-graph) both;
        }

        .shortcuts-eyebrow {
          margin: 0 0 10px;
          color: var(--dust);
          font: 500 10px/1 var(--font-mono);
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }

        .shortcuts-list {
          display: grid;
          gap: 8px;
          margin: 0;
        }

        .shortcuts-row {
          display: grid;
          grid-template-columns: 96px 1fr;
          align-items: center;
          gap: 12px;
        }

        .shortcuts-row dt,
        .shortcuts-row dd {
          margin: 0;
        }

        .shortcuts-row dd {
          color: rgba(238, 234, 248, 0.78);
          font-size: 13px;
        }

        .node-parent .node-name {
          color: color-mix(in oklab, var(--ember) 70%, white);
        }

        .hud-route {
          max-width: min(760px, calc(100vw - 56px));
          position: fixed;
          top: max(24px, env(safe-area-inset-top));
          left: 28px;
          z-index: 4;
        }

        .hud-eyebrow {
          margin: 0;
          color: var(--dust);
          font: 500 10.5px/1 var(--font-mono);
          letter-spacing: 0.2em;
          text-transform: uppercase;
        }

        .route {
          margin: 10px 0 0 -6px;
          padding: 0;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 2px;
          list-style: none;
          font: 500 13.5px/1.2 var(--font-ui);
        }

        .route-stop {
          display: flex;
          align-items: center;
          gap: 2px;
        }

        .route-stop + .route-stop::before {
          content: "";
          width: 16px;
          height: 1px;
          margin: 0 2px;
          background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--ember) 55%, transparent), transparent);
        }

        .route-link,
        .route-here {
          padding: 5px 6px;
          border-radius: 6px;
          font: inherit;
          white-space: nowrap;
        }

        .route-link {
          border: 0;
          background: transparent;
          color: rgba(238, 234, 248, 0.56);
          cursor: pointer;
          transition:
            color 160ms ease,
            background 160ms ease;
        }

        .route-link:hover {
          color: var(--ink);
          background: rgba(238, 234, 248, 0.06);
        }

        .route-link:focus-visible {
          outline: 1.5px solid var(--aura);
          outline-offset: 1px;
        }

        .route-here {
          color: var(--ink);
          font-weight: 700;
        }

        .route-gap {
          padding: 0 4px;
          color: var(--dust);
        }

        .hud-hint {
          margin: 6px 0 0;
          color: var(--dust);
          font-size: 12.5px;
          line-height: 1.4;
        }

        .hud-empty {
          max-width: 340px;
          margin: 8px 0 0;
          color: color-mix(in oklab, var(--ember) 70%, white);
          font-size: 12.5px;
          line-height: 1.4;
        }

        .sound-control {
          max-width: min(280px, calc(50vw - 250px));
          position: fixed;
          left: 24px;
          bottom: max(24px, env(safe-area-inset-bottom));
          z-index: 4;
          display: flex;
          align-items: center;
          gap: 11px;
        }

        .sound-button {
          width: 38px;
          height: 38px;
          flex: 0 0 auto;
          display: grid;
          place-items: center;
          padding: 0;
          border: 1px solid rgba(238, 234, 248, 0.14);
          border-radius: 50%;
          background: rgba(10, 10, 26, 0.55);
          color: var(--ink);
          cursor: pointer;
          backdrop-filter: blur(14px);
          transition:
            border-color 200ms ease,
            background 200ms ease,
            transform 140ms var(--ease-graph);
        }

        .sound-button:hover {
          border-color: color-mix(in oklab, var(--aura) 50%, transparent);
          background: rgba(16, 16, 36, 0.72);
        }

        .sound-button:active {
          transform: scale(0.94);
        }

        .sound-button:focus-visible {
          outline: 1.5px solid var(--aura);
          outline-offset: 3px;
        }

        .sound-bars {
          height: 14px;
          display: flex;
          align-items: flex-end;
          gap: 2.5px;
        }

        .sound-bars span {
          width: 3px;
          border-radius: 2px;
          background: var(--aura);
          box-shadow: 0 0 8px color-mix(in oklab, var(--aura) 60%, transparent);
        }

        .sound-bars span:nth-child(1) {
          height: calc(3px + var(--band-0, 0) * 11px);
        }

        .sound-bars span:nth-child(2) {
          height: calc(3px + var(--band-1, 0) * 14px);
        }

        .sound-bars span:nth-child(3) {
          height: calc(3px + var(--band-2, 0) * 18px);
        }

        .sound-copy {
          min-width: 0;
          display: grid;
          gap: 4px;
        }

        .sound-eyebrow {
          color: var(--dust);
          font: 500 9.5px/1 var(--font-mono);
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }

        .sound-title {
          overflow: hidden;
          color: rgba(238, 234, 248, 0.82);
          font: 500 12.5px/1.2 var(--font-ui);
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .hud-credit {
          position: fixed;
          right: 20px;
          bottom: max(20px, env(safe-area-inset-bottom));
          z-index: 4;
          display: flex;
          align-items: center;
          gap: 5px;
          margin: 0;
          color: rgba(238, 234, 248, 0.5);
          font: 500 10px/1 var(--font-ui);
          letter-spacing: 0.02em;
        }

        .hud-credit-mark {
          width: 11px;
          height: 11px;
          display: block;
        }

        .sr-only {
          width: 1px;
          height: 1px;
          position: absolute;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
        }

        .artist-picker {
          width: min(440px, calc(100vw - 32px));
          position: fixed;
          bottom: max(24px, env(safe-area-inset-bottom));
          left: 50%;
          z-index: 7;
          transform: translateX(-50%);
        }

        .search-dim-overlay {
          position: fixed;
          inset: 0;
          z-index: 5;
          pointer-events: none;
          background: rgba(4, 4, 11, 0.6);
          opacity: 0;
          transition: opacity 220ms ease;
        }

        .artist-picker:focus-within + .search-dim-overlay {
          opacity: 1;
        }

        .artist-search-control {
          height: 50px;
          display: flex;
          align-items: center;
          gap: 12px;
          box-sizing: border-box;
          padding: 0 10px 0 18px;
          border: 1px solid rgba(238, 234, 248, 0.12);
          border-radius: 999px;
          background: rgba(9, 9, 24, 0.6);
          box-shadow:
            0 20px 50px rgba(0, 0, 0, 0.45),
            inset 0 1px 0 rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(18px) saturate(1.2);
          cursor: text;
          transition:
            border-color 200ms ease,
            box-shadow 200ms ease,
            background 200ms ease;
        }

        .artist-picker:hover .artist-search-control {
          border-color: rgba(238, 234, 248, 0.2);
        }

        .artist-picker:focus-within .artist-search-control {
          border-color: color-mix(in oklab, var(--aura) 55%, transparent);
          background: rgba(9, 9, 24, 0.86);
          box-shadow:
            0 24px 60px rgba(0, 0, 0, 0.55),
            0 0 0 4px color-mix(in oklab, var(--aura) 12%, transparent);
        }

        .artist-search-icon {
          width: 15px;
          height: 15px;
          flex: 0 0 auto;
          position: relative;
          color: var(--dust);
        }

        .artist-search-icon::before {
          content: "";
          width: 10px;
          height: 10px;
          position: absolute;
          top: 0;
          left: 0;
          box-sizing: border-box;
          border: 1.5px solid currentColor;
          border-radius: 50%;
        }

        .artist-search-icon::after {
          content: "";
          width: 6px;
          height: 1.5px;
          position: absolute;
          right: 0;
          bottom: 2px;
          border-radius: 999px;
          background: currentColor;
          transform: rotate(45deg);
        }

        .artist-search-input {
          min-width: 0;
          flex: 1;
          border: 0;
          outline: 0;
          background: transparent;
          color: var(--ink);
          font: 500 14px/1 var(--font-ui);
        }

        .artist-search-input::placeholder {
          color: var(--dust);
        }

        .artist-search-input::-webkit-search-cancel-button {
          display: none;
        }

        .search-kbd {
          flex: 0 0 auto;
          padding: 6px 9px;
          border: 1px solid rgba(238, 234, 248, 0.1);
          border-radius: 999px;
          color: var(--dust);
          font: 500 10.5px/1 var(--font-mono);
          letter-spacing: 0.06em;
        }

        .artist-picker:focus-within .search-kbd {
          opacity: 0;
        }

        .artist-search-panel {
          width: 100%;
          max-height: min(400px, 56vh);
          position: absolute;
          bottom: calc(100% + 10px);
          left: 0;
          overflow: auto;
          box-sizing: border-box;
          padding: 6px;
          border: 1px solid rgba(238, 234, 248, 0.1);
          border-radius: 22px;
          background: rgba(9, 9, 24, 0.84);
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(20px) saturate(1.2);
          animation: panel-rise 220ms var(--ease-graph) both;
        }

        .artist-search-message {
          padding: 14px 14px 12px;
          color: var(--dust);
          font-size: 13px;
          font-weight: 500;
          line-height: 1.35;
        }

        .artist-search-message-error {
          color: #ffd2bf;
        }

        .artist-search-result {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 7px 8px;
          border: 0;
          border-radius: 16px;
          background: transparent;
          color: var(--ink);
          cursor: pointer;
          text-align: left;
          transition:
            background 150ms ease,
            transform 140ms var(--ease-graph);
        }

        .artist-search-result:hover,
        .artist-search-result:focus-visible {
          outline: none;
          background: rgba(238, 234, 248, 0.07);
        }

        .artist-search-result[aria-selected="true"] {
          background: color-mix(in oklab, var(--aura) 14%, transparent);
        }

        .artist-search-result:active {
          transform: scale(0.985);
        }

        .artist-search-result:disabled {
          cursor: default;
          opacity: 0.7;
        }

        .artist-search-result-media {
          width: 40px;
          height: 40px;
          position: relative;
          flex: 0 0 auto;
          display: grid;
          place-items: center;
          overflow: hidden;
          border-radius: 50%;
          background: radial-gradient(circle at 34% 30%, #2b2944, #0b0a17 72%);
          box-shadow: 0 0 0 1px rgba(238, 234, 248, 0.1);
          color: var(--ink);
          font: 500 15px/1 var(--font-display);
        }

        .artist-search-result-image {
          width: 100%;
          height: 100%;
          display: block;
          object-fit: cover;
        }

        .artist-search-result-copy {
          min-width: 0;
          display: grid;
          gap: 4px;
        }

        .artist-search-result-name {
          overflow: hidden;
          font-size: 14px;
          font-weight: 500;
          line-height: 1.15;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .artist-search-result-meta {
          color: var(--dust);
          font: 500 10px/1 var(--font-mono);
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }

        .load-error {
          width: max-content;
          max-width: min(520px, calc(100vw - 40px));
          position: fixed;
          bottom: 92px;
          left: 50%;
          z-index: 6;
          box-sizing: border-box;
          margin: 0;
          padding: 10px 16px;
          transform: translateX(-50%);
          border: 1px solid color-mix(in oklab, var(--ember) 30%, transparent);
          border-radius: 14px;
          background: rgba(22, 10, 14, 0.72);
          color: #ffd9c7;
          font-size: 12.5px;
          font-weight: 500;
          line-height: 1.45;
          text-align: center;
          backdrop-filter: blur(14px);
        }

        @keyframes node-spin {
          to {
            transform: rotate(360deg);
          }
        }

        @keyframes orbit-spin {
          to {
            transform: rotate(360deg);
          }
        }

        @keyframes node-drift {
          0%,
          100% {
            transform: translate3d(var(--node-drift-x-a), var(--node-drift-y-a), 0);
          }

          50% {
            transform: translate3d(var(--node-drift-x-b), var(--node-drift-y-b), 0);
          }
        }

        @keyframes node-emerge {
          from {
            opacity: 0;
            transform: translate(var(--emerge-x), var(--emerge-y)) scale(0.2);
            filter: blur(8px);
          }

          55% {
            opacity: 1;
            filter: blur(0);
          }

          to {
            opacity: 1;
            transform: none;
            filter: none;
          }
        }

        @keyframes corona-breathe {
          0%,
          100% {
            opacity: 0.8;
            transform: scale(0.96);
          }

          50% {
            opacity: 1;
            transform: scale(1.05);
          }
        }

        @keyframes nebula-breathe {
          from {
            scale: 1;
            opacity: 0.85;
          }

          to {
            scale: 1.08;
            opacity: 1;
          }
        }

        @keyframes panel-rise {
          from {
            opacity: 0;
            transform: translateY(6px);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .node-float,
          .node-emerge,
          .corona,
          .vinyl-label,
          .nebula,
          .orbit-ring,
          .artist-search-panel {
            animation: none;
          }

          .cosmos {
            transition: none;
          }
        }

        @media (max-width: 640px) {
          .graph-frame {
            width: min(100vw, 78vh);
          }

          .sound-control {
            max-width: none;
            top: max(14px, env(safe-area-inset-top));
            right: 14px;
            bottom: auto;
            left: auto;
          }

          .sound-copy {
            display: none;
          }

          .hud-route {
            max-width: calc(100vw - 80px);
            top: max(16px, env(safe-area-inset-top));
            left: 16px;
          }

          .route {
            font-size: 12.5px;
          }

          .hud-hint {
            display: none;
          }

          .hud-credit {
            right: 50%;
            bottom: calc(max(24px, env(safe-area-inset-bottom)) + 58px);
            transform: translateX(50%);
            white-space: nowrap;
          }

          .load-error {
            bottom: 140px;
          }

          .node-name {
            font-size: 11.5px;
          }

          .node-focus .node-name {
            font-size: 28px;
          }

          .search-kbd {
            display: none;
          }
        }
      `}</style>

      <Starfield camera={camera} />
      <div aria-hidden="true" className="nebula" style={{ transform: `translate3d(${(-cameraDriftX * 0.05).toFixed(1)}px, ${(-cameraDriftY * 0.05).toFixed(1)}px, 0)` }} />

      <section aria-label="Map of related artists" className="graph-stage">
        <div className="graph-frame">
          <svg aria-hidden="true" className="graph-svg" viewBox={`0 0 ${SIZE} ${SIZE}`}>
            <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
              <g>
                {orbitRings.map((ring) => (
                  <circle
                    className={`orbit-ring orbit-ring-${ring.role}`}
                    cx={ring.x}
                    cy={ring.y}
                    key={ring.id}
                    r={ring.radius}
                    style={{ animationDuration: `${Math.round(ring.radius * 0.45)}s` }}
                  />
                ))}
              </g>

              <g>
                {edges.map((edge) => (
                  <line className={`edge edge-${edge.role}`} key={edge.id} x1={edge.parent.x} y1={edge.parent.y} x2={edge.child.x} y2={edge.child.y} />
                ))}
                {previewEdges.map((edge) => (
                  <line
                    className={`edge edge-preview${edge.parentId === hoveredId ? " edge-preview-lit" : ""}`}
                    key={edge.id}
                    x1={edge.x1}
                    y1={edge.y1}
                    x2={edge.x2}
                    y2={edge.y2}
                  />
                ))}
              </g>
            </g>
          </svg>
          <div className="node-html-layer">
            <div className="node-world" style={cameraStyle(camera)}>
              {renderedNodes.map((node) => {
                const role = roles.get(node.id) ?? "ghost";
                const radius = nodeRadius(role, node, focusedNode);
                const isInteractive =
                  !isTraveling && isInteractiveRole(role) && (role !== "focus" || node.childrenStatus === "error") && node.childrenStatus !== "loading";

                return renderArtistNode(node, role, radius, camera.scale, { interactive: isInteractive });
              })}
            </div>
          </div>
        </div>
      </section>

      <div aria-hidden="true" className="fog" />

      <nav aria-label="Your route" className="hud-route">
        <p className="hud-eyebrow">{jumps === 0 ? "Starting point" : `Route · ${jumps} ${jumps === 1 ? "jump" : "jumps"}`}</p>
        <ol className="route">
          {visibleRoute.map((stop, index) =>
            stop ? (
              <li className="route-stop" key={stop.id}>
                {stop.id === cameraFocusedNode.id ? (
                  <span aria-current="location" className="route-here">
                    {stop.label}
                  </span>
                ) : (
                  <button className="route-link" disabled={isTraveling} onClick={() => void focusNode(stop.id)} type="button">
                    {stop.label}
                  </button>
                )}
              </li>
            ) : (
              <li className="route-stop" key={`gap-${index}`}>
                <span className="route-gap">…</span>
              </li>
            )
          )}
        </ol>
        {isDeadEnd ? (
          <p className="hud-empty">Deezer has no related artists for {cameraFocusedNode.label}. Go back a step or search for someone else.</p>
        ) : jumps === 0 ? (
          <p className="hud-hint">
            Pick an orbiting artist to travel to them. Press <kbd className="hud-key">?</kbd> for shortcuts.
          </p>
        ) : null}
      </nav>

      <div className={`sound-control${nowPlaying ? " sound-control-playing" : ""}`}>
        <button
          aria-label={soundOn && audioUnlocked ? "Mute previews" : "Play previews"}
          aria-pressed={soundOn && audioUnlocked}
          className="sound-button"
          onClick={handleSoundClick}
          onPointerDown={handleSoundPointerDown}
          type="button"
        >
          {nowPlaying ? (
            <span aria-hidden="true" className="sound-bars">
              <span />
              <span />
              <span />
            </span>
          ) : (
            <SoundIcon muted={!soundOn} />
          )}
        </button>
        <span aria-live="polite" className="sound-copy">
          {!soundOn ? (
            <span className="sound-title">Previews muted</span>
          ) : !audioUnlocked ? (
            <span className="sound-title">Play previews</span>
          ) : nowPlaying ? (
            <>
              <span className="sound-eyebrow">Now playing</span>
              <span className="sound-title">{nowPlaying}</span>
            </>
          ) : playingPreviews && playingPreviews.length === 0 ? (
            <span className="sound-title">No preview for {playingNode.label}</span>
          ) : (
            <span className="sound-title">Tuning in…</span>
          )}
        </span>
      </div>

      <p className="hud-credit">
        <img alt="" className="hud-credit-mark" src={DEEZER_MARK} />
        Deezer
      </p>

      {showShortcuts ? (
        <div aria-label="Keyboard shortcuts" className="shortcuts" role="dialog">
          <p className="shortcuts-eyebrow">Keyboard</p>
          <dl className="shortcuts-list">
            {[
              ["← → ↑ ↓", "Move between orbiting artists"],
              ["Enter", "Travel to the highlighted artist"],
              ["1 – 9", "Travel to an artist, left to right"],
              ["⌫", "Go back one step"],
              ["M", "Mute or unmute previews"],
              ["/  ⌘K", "Search for an artist"],
              ["?", "Show or hide shortcuts"]
            ].map(([keys, action]) => (
              <div className="shortcuts-row" key={keys}>
                <dt>
                  <kbd className="hud-key">{keys}</kbd>
                </dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <form
        className="artist-picker"
        onFocusOut={() => {
          // Keyboard users tabbing out of the search should close the results too. Browsers don't always
          // report where focus went, so check once it has landed.
          window.setTimeout(() => {
            const active = document.activeElement;
            if (active && active !== document.body && !artistPickerRef.current?.contains(active)) {
              setIsArtistPickerOpen(false);
            }
          }, 0);
        }}
        onSubmit={handleArtistSearchSubmit}
        ref={artistPickerRef}
      >
        <label className="sr-only" htmlFor="core-artist-search">
          Start from another artist
        </label>
        <div className="artist-search-control" onClick={() => focusArtistSearchInput()}>
          <span aria-hidden="true" className="artist-search-icon" />
          <input
            aria-autocomplete="list"
            aria-controls="core-artist-search-results"
            aria-expanded={showArtistSearchPanel}
            autoComplete="off"
            className="artist-search-input"
            id="core-artist-search"
            onFocus={() => setIsArtistPickerOpen(true)}
            onInput={(event) => {
              setArtistSearchText((event.currentTarget as HTMLInputElement).value);
              setIsArtistPickerOpen(true);
            }}
            onKeyDown={handleArtistSearchKeyDown}
            placeholder="Start from another artist"
            ref={artistSearchInputRef}
            type="search"
            value={artistSearchText}
          />
          <kbd aria-hidden="true" className="search-kbd">
            ⌘K
          </kbd>
        </div>

        {showArtistSearchPanel ? (
          <div className="artist-search-panel" id="core-artist-search-results" role="listbox">
            {artistSearchStatus === "searching" ? <div className="artist-search-message">Searching Deezer…</div> : null}
            {artistSearchStatus === "error" ? <div className="artist-search-message artist-search-message-error">{artistSearchError}</div> : null}
            {artistSearchStatus === "idle" && trimmedArtistSearchText.length >= 2 && artistSearchResults.length === 0 ? (
              <div className="artist-search-message">No artists match “{trimmedArtistSearchText}”. Try a different spelling.</div>
            ) : null}
            {artistSearchResults.map((artist) => (
              <button
                aria-selected={artist.id === coreArtistId}
                className="artist-search-result"
                disabled={rootLoadId === artist.id}
                key={artist.id}
                onClick={() => void chooseCoreArtist(artist)}
                role="option"
                type="button"
              >
                <span className="artist-search-result-media">
                  {artist.imageUrl ? <img alt="" className="artist-search-result-image" crossOrigin="anonymous" draggable={false} src={artist.imageUrl} /> : <VinylRecord />}
                </span>
                <span className="artist-search-result-copy">
                  <span className="artist-search-result-name">{artist.name}</span>
                  <span className="artist-search-result-meta">{artist.id === coreArtistId ? "Current start" : formatFans(artist.fans)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </form>
      <div aria-hidden="true" className="search-dim-overlay" />

      {loadError ? (
        <p className="load-error" role="alert">
          {loadError}
        </p>
      ) : null}
    </main>
  );
}

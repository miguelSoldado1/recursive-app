import { boolean, capsule, endpoint, mutation, query, string, table, text } from "lakebed/server";
import {
  ARTIST_SEARCH_LIMIT,
  KENDRICK_LAMAR_ID,
  RELATED_ARTIST_LIMIT,
  ROOT_RELATED_ARTIST_LIMIT,
  type ArtistNeighborhood,
  type ArtistNeighborhoodResult,
  type ArtistSearchResult,
  type ArtistSummary
} from "../shared/artist";

// All artist data comes from Deezer's public API, which needs no credentials.
type DeezerArtistObject = {
  id?: number;
  link?: string;
  name?: string;
  nb_fan?: number;
  picture_big?: string;
};
type DeezerTrackObject = {
  contributors?: DeezerArtistObject[];
};
type DeezerList<T> = {
  data?: T[];
};
type DeezerErrorBody = {
  error?: {
    code?: number;
    message?: string;
  };
};
type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const DEEZER_API = "https://api.deezer.com";
const DEEZER_CACHE_TTL_MS = 10 * 60 * 1000;
const DEEZER_QUOTA_ERROR_CODE = 4;
const DEEZER_NOT_FOUND_ERROR_CODE = 800;
const COLLABORATOR_TRACK_LIMIT = 50;
const ROOT_RELATED_ARTIST_CANDIDATE_LIMIT = ROOT_RELATED_ARTIST_LIMIT * 3;
const RELATED_ARTIST_CANDIDATE_LIMIT = RELATED_ARTIST_LIMIT * 5;

const deezerCache = new Map<string, CacheEntry>();
const deezerInflight = new Map<string, Promise<unknown>>();

class DeezerError extends Error {
  code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

async function fetchDeezerJson<T>(path: string): Promise<T> {
  const response = await fetch(`${DEEZER_API}${path}`);
  if (!response.ok) {
    throw new DeezerError(`Deezer request failed with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as T & DeezerErrorBody;
  if (body.error) {
    // Deezer allows 50 requests per 5 seconds per client.
    if (body.error.code === DEEZER_QUOTA_ERROR_CODE) {
      throw new DeezerError("Deezer is receiving too many requests. Wait a few seconds and try again.", body.error.code);
    }

    throw new DeezerError(
      body.error.code === DEEZER_NOT_FOUND_ERROR_CODE ? "Deezer has no data for this artist." : `Deezer request failed: ${body.error.message ?? "unknown error"}.`,
      body.error.code
    );
  }

  return body;
}

async function requestDeezer<T>(path: string): Promise<T> {
  const cached = deezerCache.get(path);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as T;
  }

  const inflight = deezerInflight.get(path);
  if (inflight) {
    return (await inflight) as T;
  }

  const request = fetchDeezerJson<T>(path).then((value) => {
    deezerCache.set(path, {
      expiresAt: Date.now() + DEEZER_CACHE_TTL_MS,
      value
    });
    return value;
  });

  deezerInflight.set(path, request);

  try {
    return await request;
  } finally {
    deezerInflight.delete(path);
  }
}

function normalizeDeezerArtist(artist: DeezerArtistObject): ArtistSummary | undefined {
  if (!artist.id || !artist.name) {
    return undefined;
  }

  // Artists without a photo get a placeholder URL with an empty image hash ("/artist//").
  const hasPicture = Boolean(artist.picture_big) && !artist.picture_big?.includes("/artist//");

  return {
    id: String(artist.id),
    name: artist.name,
    imageUrl: hasPicture ? artist.picture_big : undefined,
    url: artist.link,
    fans: artist.nb_fan
  };
}

function normalizeDeezerArtists(artists: DeezerArtistObject[] | undefined, excludeId?: string) {
  const seenIds = new Set<string>();
  const normalized: ArtistSummary[] = [];

  for (const artist of artists ?? []) {
    const summary = normalizeDeezerArtist(artist);
    if (!summary || summary.id === excludeId || seenIds.has(summary.id)) {
      continue;
    }

    seenIds.add(summary.id);
    normalized.push(summary);
  }

  return normalized;
}

async function getArtist(artistId: string) {
  const artist = normalizeDeezerArtist(await requestDeezer<DeezerArtistObject>(`/artist/${encodeURIComponent(artistId)}`));
  if (!artist) {
    throw new DeezerError("Deezer returned an invalid artist response.");
  }

  return artist;
}

async function getSimilarArtists(artistId: string, limit: number) {
  const response = await requestDeezer<DeezerList<DeezerArtistObject>>(`/artist/${encodeURIComponent(artistId)}/related?limit=${limit}`);
  return normalizeDeezerArtists(response.data, artistId);
}

// People featured on the artist's most popular tracks, ranked by how often they show up.
async function getCollaboratorArtists(artistId: string, limit: number) {
  const response = await requestDeezer<DeezerList<DeezerTrackObject>>(`/artist/${encodeURIComponent(artistId)}/top?limit=${COLLABORATOR_TRACK_LIMIT}`);
  const scores = new Map<string, { artist: DeezerArtistObject; score: number }>();

  for (const track of response.data ?? []) {
    for (const contributor of track.contributors ?? []) {
      const id = contributor.id ? String(contributor.id) : undefined;
      if (!id || id === artistId) {
        continue;
      }

      scores.set(id, {
        artist: contributor,
        score: (scores.get(id)?.score ?? 0) + 1
      });
    }
  }

  const ranked = Array.from(scores.values())
    .sort((first, second) => second.score - first.score)
    .map((entry) => entry.artist);

  return normalizeDeezerArtists(ranked, artistId).slice(0, limit);
}

async function getRelatedArtists(artistId: string, limit: number) {
  const related = await getSimilarArtists(artistId, limit);
  if (related.length >= limit) {
    return related;
  }

  const relatedIds = new Set(related.map((artist) => artist.id));
  const collaborators = (await getCollaboratorArtists(artistId, limit)).filter((artist) => !relatedIds.has(artist.id));

  return [...related, ...collaborators].slice(0, limit);
}

async function getArtistNeighborhood(artistId: string, limit: number): Promise<ArtistNeighborhood> {
  const [artist, related] = await Promise.all([getArtist(artistId), getRelatedArtists(artistId, limit)]);

  return {
    artist,
    related
  };
}

async function searchArtists(term: string) {
  const queryText = term.trim();
  if (queryText.length < 2) {
    return [];
  }

  const response = await requestDeezer<DeezerList<DeezerArtistObject>>(`/search/artist?q=${encodeURIComponent(queryText)}&limit=${ARTIST_SEARCH_LIMIT}`);
  const results = normalizeDeezerArtists(response.data);
  const nameKey = (artist: ArtistSummary) => artist.name.trim().toLowerCase();
  const firstPositionByName = new Map<string, number>();
  results.forEach((artist, index) => {
    if (!firstPositionByName.has(nameKey(artist))) {
      firstPositionByName.set(nameKey(artist), index);
    }
  });

  // Keep Deezer's relevance order, but when several artists share a name, list the most-followed first.
  return results.sort(
    (first, second) =>
      (firstPositionByName.get(nameKey(first)) ?? 0) - (firstPositionByName.get(nameKey(second)) ?? 0) || (second.fans ?? 0) - (first.fans ?? 0)
  );
}

async function getArtistNeighborhoodResult(artistId: string, limit: number): Promise<ArtistNeighborhoodResult> {
  try {
    return {
      ok: true,
      data: await getArtistNeighborhood(artistId, limit)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load artist data from Deezer."
    };
  }
}

async function getArtistSearchResult(term: string): Promise<ArtistSearchResult> {
  try {
    return {
      ok: true,
      data: await searchArtists(term)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to search Deezer artists."
    };
  }
}

export default capsule({
  name: "recursive-app",

  schema: {
    todos: table({
      text: string(),
      done: boolean().default(false),
      ownerId: string()
    })
  },

  queries: {
    artistRoot: query(() => getArtistNeighborhoodResult(KENDRICK_LAMAR_ID, ROOT_RELATED_ARTIST_CANDIDATE_LIMIT))
  },

  mutations: {
    searchArtists: mutation((_ctx, term: string) => getArtistSearchResult(term)),
    loadRootArtist: mutation((_ctx, artistId: string) => getArtistNeighborhoodResult(artistId, ROOT_RELATED_ARTIST_CANDIDATE_LIMIT)),
    loadRelatedArtists: mutation((_ctx, artistId: string) => getArtistNeighborhoodResult(artistId, RELATED_ARTIST_CANDIDATE_LIMIT))
  },

  endpoints: {
    status: endpoint({ method: "GET", path: "/api/status" }, () => text("ok"))
  }
});

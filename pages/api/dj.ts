import type { NextApiRequest, NextApiResponse } from "next";
import spotifyUri from "spotify-uri";
import SpotifyWebApi from "spotify-web-api-node";

const URL_REGEX = /(https?:\/\/[^ ]*)/;

const {
  SPOTIFY_ARCHIVE_PLAYLIST_ID,
  SPOTIFY_MONTHLY_PLAYLIST_ID,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_AUTHORIZATION_CODE,
  SPOTIFY_REFRESH_TOKEN,
} = process.env;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const tokens = parseSlackWebhookPayload(req.body, {
    isLocalDevelopment: process.env.NODE_ENV === "development",
  });
  const isValidPayload = isValidSlackWebhookPayload(tokens);

  if (!isValidPayload) {
    res.status(400).end();
    return;
  }

  getSpotifyAuthorizeURL();
  const spotifyURL = getSpotifyURI(tokens.text);

  if (spotifyURL === undefined) {
    res.status(400).end();
    return;
  }

  try {
    const json = await addTrackToPlaylist(spotifyURL);
    console.log("json", json);
  } catch (err) {
    res.status(500).end();
  }

  res.status(200).end();
}

/**
 * @example
 * token=KRRTYv33kV3pdksdfsdfutOmmQ&team_id=T0CAQ00TU&team_domain=boba&service_id=33423964sdsd27&channel_id=C03AS41V0AC&channel_name=john-test&timestamp=1649115407.399629&user_id=U0asdA4JLBF&user_name=john.pham&text=%3Chttps%3A%2F%2Fopen.spotify.com%2Ftrack%2F6J1Qcreg3a9hlJuvJCvjl5%3Fsi%3D2vEISP1TS0iilwluZTeDSQ%3E
 */
const parseSlackWebhookPayload = (
  payload: string,
  { isLocalDevelopment }: { isLocalDevelopment: boolean }
) => {
  if (isLocalDevelopment) {
    const tokens = payload.split("&").reduce((prev: any, cur: any) => {
      const [key, value] = cur.split("=");
      return {
        ...prev,
        [key]: value,
      };
    }, {});

    return tokens;
  }

  return payload;
};

const isValidSlackWebhookPayload = (payload: any) => {
  const MUST_HAVE_KEYS = ["token", "channel_id", "text"];
  const hasMustHaveKeys = MUST_HAVE_KEYS.every((key) => !!payload[key]);

  return hasMustHaveKeys;
};

const getSpotifyURI = (text: string) => {
  const textTokens = decodeURIComponent(text).match(URL_REGEX);
  let spotifyURL = undefined;

  if (textTokens !== null && textTokens.length > 0) {
    spotifyURL = textTokens[1].slice(0, -1);
  }

  if (spotifyURL) {
    const parsedSpotifyURL = spotifyUri.parse(spotifyURL);

    if (parsedSpotifyURL.type === "track") {
      spotifyURL = parsedSpotifyURL.toURI();
      console.log(spotifyURL);
    }
  }

  return spotifyURL;
};

const addTrackToPlaylist = async (spotifyURL: string) => {
  const spotifyApi = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET,
    redirectUri: "https://pham.codes/callback",
  });

  spotifyApi.setAccessToken(SPOTIFY_AUTHORIZATION_CODE as string);
  spotifyApi.setRefreshToken(SPOTIFY_REFRESH_TOKEN as string);

  const refreshAccessTokenResponse = await spotifyApi.refreshAccessToken();
  spotifyApi.setAccessToken(refreshAccessTokenResponse.body.access_token);
  try {
    // Add the track to both the archive and monthly playlists.
    const addTrackToArchivePlaylistPromise = spotifyApi.addTracksToPlaylist(
      SPOTIFY_ARCHIVE_PLAYLIST_ID as string,
      [spotifyURL]
    );
    const addTrackToMonthlyPlaylistPromise = spotifyApi.addTracksToPlaylist(
      SPOTIFY_MONTHLY_PLAYLIST_ID as string,
      [spotifyURL]
    );
    await Promise.allSettled([
      addTrackToArchivePlaylistPromise,
      addTrackToMonthlyPlaylistPromise,
    ]);

    await pruneOldTracksFromPlaylist(
      spotifyApi,
      SPOTIFY_MONTHLY_PLAYLIST_ID as string,
      // Ignoring the fact that months are not always 30 days long. 🙈
      30
    );

    console.log(`Added ${spotifyURL} to playlist`);
  } catch (e) {
    console.error(`Failed to add ${spotifyURL}`, e);
  }

  return {};
};

/**
 * The URL used by you to authorize the Spotify API to act on your behalf.
 */
const getSpotifyAuthorizeURL = () => {
  const scopes = ["playlist-modify-public", "playlist-modify-private"],
    state = "some-state-of-my-choice";

  const spotifyApi = new SpotifyWebApi({
    redirectUri: "https://pham.codes/callback",
    clientId: SPOTIFY_CLIENT_ID,
  });

  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, state);

  console.log(authorizeURL);
};

/**
 * Removes all tracks from a playlist that were added more than `ageToPruneInDays` ago.
 */
const pruneOldTracksFromPlaylist = async (
  spotifyClient: SpotifyWebApi,
  playlistID: string,
  ageToPruneInDays = 30
) => {
  const TODAY = new Date();
  // TODO: Handle pagination
  const { body } = await spotifyClient.getPlaylistTracks(playlistID, {
    limit: 50,
  });

  const { items } = body;

  const tracksToRemove = items.filter((track) => {
    const diffInTime = TODAY.getTime() - new Date(track.added_at).getTime();
    const diffInDays = diffInTime / (1000 * 3600 * 24);

    return diffInDays >= ageToPruneInDays;
  });

  const tracksToRemoveURIs = tracksToRemove.map((track) => ({
    uri: track.track.uri,
  }));

  await spotifyClient.removeTracksFromPlaylist(playlistID, tracksToRemoveURIs);
  console.log(
    `Pruned ${tracksToRemoveURIs.length} tracks from playlist ${playlistID}.`
  );
};

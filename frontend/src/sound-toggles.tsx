/**
 * The sound and music switches. They live in the site header, and the table's
 * top line shows them too while the header is hidden for fullscreen play.
 */
export function SoundToggles({
  sound,
  music,
  onSound,
  onMusic,
}: {
  sound: boolean;
  music: boolean;
  onSound: () => void;
  onMusic: () => void;
}) {
  return (
    <>
      <button
        className="icon-button"
        onClick={onSound}
        aria-label={sound ? "关闭声音" : "打开声音"}
        aria-pressed={sound}
        title={sound ? "牌声：开" : "牌声：关"}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" />
          {sound ? (
            <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" />
          ) : (
            <path d="m16 9.5 5 5m0-5-5 5" />
          )}
        </svg>
      </button>
      <button
        className="icon-button"
        onClick={onMusic}
        aria-label={music ? "关闭牌桌音乐" : "打开牌桌音乐"}
        aria-pressed={music}
        title={music ? "牌桌音乐：开" : "牌桌音乐：关"}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 17.5V6l10-2v11.5" />
          <circle cx="6.5" cy="17.5" r="2.5" />
          <circle cx="16.5" cy="15.5" r="2.5" />
          {!music && <path d="m3.5 3.5 17 17" />}
        </svg>
      </button>
    </>
  );
}

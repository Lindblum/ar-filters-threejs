import { useEffect, useState } from 'react';

// The desktop test feed (Background → Test Feed, outside XR): a webcam, or a
// video file dropped on the page, standing in for the phone's camera so the
// depth model, the filters and the depth passthrough can be tried without a
// phone. It has no tracking: its camera stays put (see TEST_CAMERA).

/**
 * While `enabled`, a playing <video> of the webcam, replaced by any video
 * file dropped on the page. Returns { video, error }.
 */
export function useTestFeed(enabled) {
  const [video, setVideo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let stream = null;
    let objectUrl = null;
    const element = document.createElement('video');
    element.muted = true;
    element.playsInline = true;
    element.loop = true;
    const play = () =>
      element.play().then(() => {
        if (!cancelled) setVideo(element);
      });

    navigator.mediaDevices
      ?.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        stream = s;
        if (cancelled) return;
        element.srcObject = s;
        return play();
      })
      .catch((e) => {
        if (!cancelled) setError(`No webcam (${e?.name ?? 'error'}); drop a video file on the page instead`);
      });

    const onDragOver = (e) => e.preventDefault();
    const onDrop = (e) => {
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('video/'));
      if (!file) return;
      e.preventDefault();
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file);
      element.srcObject = null;
      element.src = objectUrl;
      setError(null);
      play().catch((err) => setError(`Couldn't play ${file.name}: ${err?.message ?? err}`));
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);

    return () => {
      cancelled = true;
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      stream?.getTracks().forEach((t) => t.stop());
      element.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setVideo(null);
      setError(null);
    };
  }, [enabled]);

  return { video, error };
}

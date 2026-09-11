"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { Button } from "@/components/ui/button";

/**
 * Deliberately a minimal duck-typed shape rather than an imported
 * @zxing/browser type name — this sandbox has no npm registry access to
 * confirm exactly which type names that package exports, and every
 * decoder callback in its API hands back an object with a callable
 * stop(), which is the only thing this component ever does with it.
 */
interface ScannerControls {
  stop: () => void;
}

export interface BarcodeScannerModalProps {
  /** Called with the decoded text the moment a barcode is read. Unmount this component right after — it does not call this twice. */
  onDetected: (text: string) => void;
  onClose: () => void;
}

/**
 * Camera-based barcode scanning — the "phone camera for mobile" part of
 * this project's scanning request. USB/Bluetooth scanners already worked
 * before this (till.tsx's search box treats one as a keyboard typing a
 * code then Enter — see tryAddByBarcode() there); this modal is the only
 * genuinely new scanning surface.
 *
 * Decoding is done entirely in the browser by @zxing/browser reading
 * frames off a live <video> feed, not the native BarcodeDetector API —
 * that API has no Safari/iOS implementation, and a till that only scans
 * on some phones would not meet "phone camera for mobile" as asked.
 * @zxing/browser works the same everywhere getUserMedia does.
 *
 * Camera access requires HTTPS (or localhost) and a real user gesture to
 * open — both hold here (the "Scan" button opens this) — but a browser
 * can still refuse: permission denied, no camera present, or the camera
 * already in use by another app/tab. Each is surfaced as a plain message
 * rather than a silently blank video box.
 *
 * Deliberately has no `open` prop — the caller mounts this component only
 * while scanning should be active (`{scannerOpen ? <BarcodeScannerModal
 * .../> : null}`) rather than always rendering it with open toggled.
 * That way every piece of state here (the error message, the camera
 * connection) starts fresh on every mount with no reset-on-reopen code
 * needed, and the camera effect below only ever needs to run once per
 * mount — both sidestep the two anti-patterns (mutating a ref during
 * render, and calling setState synchronously inside an effect body just
 * to reset old state) that an `open`-prop version of this ran into.
 */
export function BarcodeScannerModal({ onDetected, onClose }: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const onDetectedRef = useRef(onDetected);
  // Refs are only ever written outside of render — here, in an effect
  // that runs after every render — never directly in the render body.
  useEffect(() => {
    onDetectedRef.current = onDetected;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stopped = false;

    // The library's default is 500ms between scan attempts — that alone
    // made scanning feel slow, so this shortens the gap to 100ms. The
    // installed @zxing/browser version takes an options object here
    // (IBrowserCodeReaderOptions), not a plain number — confirmed by a
    // real `npm run typecheck` run against it, which is what this exact
    // shape reflects.
    const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 100 });

    // Devices are enumerated (rather than left to the browser's default
    // choice) so a rear-facing camera can be preferred — the default on
    // most phones is the FRONT camera, which cannot usefully read a
    // barcode. Labels are only populated once camera permission has been
    // granted at least once for this origin; before that, every label is
    // blank, and picking a deviceId off an unlabelled list is a coin flip
    // between front and rear on many phones. So when no device has a
    // label yet, this asks the camera directly for the rear ("environment")
    // facing camera via constraints instead of guessing a deviceId — a
    // genuine improvement over blindly taking the last device in the list.
    BrowserMultiFormatReader.listVideoInputDevices()
      .then((devices) => {
        if (cancelled) return;
        if (devices.length === 0) {
          setError("No camera was found on this device.");
          return;
        }
        const hasLabels = devices.some((d) => d.label);
        const rear = hasLabels
          ? devices.find((d) => /back|rear|environment/i.test(d.label)) ?? devices[devices.length - 1]
          : undefined;

        // Decoding runs faster per frame at a moderate resolution than at
        // an unconstrained (often very high) native camera resolution —
        // 1280x720 is still far more detail than a barcode needs. This
        // switches from decodeFromVideoDevice (deviceId only) to
        // decodeFromConstraints so a resolution hint — and, when no
        // labelled device is known yet, a facingMode hint — can be passed
        // alongside the camera choice. Unlike the constructor change
        // above, this method was not exercised by the one successful
        // typecheck run so far, so it carries a little more risk.
        const constraints: MediaStreamConstraints = {
          video: rear
            ? { deviceId: { exact: rear.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        };

        return reader.decodeFromConstraints(constraints, videoRef.current ?? undefined, (result, err, controls) => {
          controlsRef.current = controls;
          if (cancelled || stopped || !result) return;
          stopped = true;
          controls.stop();
          onDetectedRef.current(result.getText());
          // NotFoundException fires continuously between frames while
          // nothing decodable is in view — that is normal scanning, not
          // a failure, so it is deliberately ignored rather than shown.
          void err;
        });
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("BarcodeScannerModal: camera start failed", e);
        setError(
          e?.name === "NotAllowedError"
            ? "Camera access was denied. Allow camera access for this site and try again."
            : "Couldn't start the camera. Make sure no other app is using it."
        );
      });

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/60 p-4 print:hidden"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm animate-slide-up rounded-2xl bg-white p-4 shadow-xl dark:bg-surface-card"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold dark:text-ink">Scan a barcode</h2>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : (
          <>
            <div className="relative mt-3 overflow-hidden rounded-xl bg-black">
              <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
              {/* Purely decorative viewfinder — a sweeping line plus
                  corner brackets so the box reads as "actively scanning"
                  rather than a plain camera preview. Never touches the
                  actual video frame @zxing/browser decodes underneath. */}
              <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-lime-400/70">
                <span className="absolute left-0 top-0 h-6 w-6 -translate-x-0.5 -translate-y-0.5 rounded-tl-lg border-l-4 border-t-4 border-lime-400" />
                <span className="absolute right-0 top-0 h-6 w-6 translate-x-0.5 -translate-y-0.5 rounded-tr-lg border-r-4 border-t-4 border-lime-400" />
                <span className="absolute bottom-0 left-0 h-6 w-6 -translate-x-0.5 translate-y-0.5 rounded-bl-lg border-b-4 border-l-4 border-lime-400" />
                <span className="absolute bottom-0 right-0 h-6 w-6 translate-x-0.5 translate-y-0.5 rounded-br-lg border-b-4 border-r-4 border-lime-400" />
                <span className="absolute inset-x-0 top-0 h-0.5 animate-scan-line bg-lime-400/90 shadow-[0_0_6px_1px_rgba(217,242,27,0.7)]" />
              </div>
            </div>
            <p className="mt-2 text-center text-sm text-neutral-500 dark:text-ink-muted">
              Point the camera at a barcode.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
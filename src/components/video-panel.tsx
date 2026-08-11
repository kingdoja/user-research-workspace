"use client";

import { Play } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

type VideoPanelProps = {
  title: string;
  description?: string;
  poster: string;
  video: string;
  featured?: boolean;
};

export function VideoPanel({
  title,
  description,
  poster,
  video,
  featured = false,
}: VideoPanelProps) {
  const [playing, setPlaying] = useState(false);

  return (
    <article className={featured ? "video-panel video-featured" : "video-panel"}>
      <div className="video-frame">
        {playing ? (
          <video src={video} poster={poster} controls autoPlay playsInline preload="metadata" />
        ) : (
          <>
            <Image
              src={poster}
              alt={`${title} 视频封面`}
              fill
              priority={featured}
              sizes={featured ? "1100px" : "600px"}
            />
            <button type="button" className="play-button" onClick={() => setPlaying(true)}>
              <Play size={22} fill="currentColor" />
              <span className="sr-only">播放 {title}</span>
            </button>
          </>
        )}
      </div>
      {description ? (
        <div className="video-copy">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      ) : null}
    </article>
  );
}

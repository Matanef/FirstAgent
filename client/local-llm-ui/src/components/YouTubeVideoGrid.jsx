// client/local-llm-ui/src/components/YouTubeVideoGrid.jsx
import { useState } from "react";

export default function YouTubeVideoGrid({ videos }) {
    if (!videos || videos.length === 0) return null;

    const [selectedVideo, setSelectedVideo] = useState(null);

    return (
        <div className="youtube-container">
            <div className="youtube-grid">
                {videos.slice(0, 4).map((video, i) => (
                    <div
                        key={i}
                        className="youtube-video-card"
                        onClick={() => setSelectedVideo(video.id)}
                    >
                        <img
                            src={`https://img.youtube.com/vi/${video.id}/mqdefault.jpg`}
                            alt={video.title}
                            className="youtube-thumbnail"
                        />
                        <div className="youtube-video-info">
                            <div className="youtube-video-title">{video.title}</div>
                            <div className="youtube-video-channel">{video.channelTitle}</div>
                        </div>
                    </div>
                ))}
            </div>

            {selectedVideo && (
                <div className="youtube-player-modal" onClick={() => setSelectedVideo(null)}>
                    <div className="youtube-player-container" onClick={e => e.stopPropagation()}>
                        <button className="youtube-close-btn" onClick={() => setSelectedVideo(null)}>×</button>
                        <iframe
                            width="100%"
                            height="100%"
                            src={`https://www.youtube.com/embed/${selectedVideo}`}
                            frameBorder="0"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            allowFullScreen
                            title="YouTube video player"
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

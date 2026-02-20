// client/local-llm-ui/src/components/WeatherWidget.jsx

export default function WeatherWidget({ data }) {
    if (!data) return null;

    return (
        <div className="weather-widget">
            <div className="weather-header">
                <span>🌤️ {data.city}, {data.country}</span>
            </div>
            <div className="weather-content">
                <div className="weather-temp">{data.temp}°C</div>
                <div className="weather-desc">{data.description}</div>
                <div className="weather-details">
                    <span>💨 Wind: {data.wind_speed} m/s</span>
                    <span>💧 Humidity: {data.humidity}%</span>
                    <span>🌡️ Feels like: {data.feels_like}°C</span>
                </div>
            </div>
        </div>
    );
}

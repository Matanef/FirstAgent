// client/local-llm-ui/src/components/WebBrowserPanel.jsx
// Renders web browsing and moltbook interaction results

import { useState } from "react";

function SessionBadge({ loginStatus, sessionActive }) {
  if (sessionActive || loginStatus === "logged_in") {
    return <span className="session-badge session-logged-in">🔓 Logged In</span>;
  }
  if (loginStatus === "logged_out") {
    return <span className="session-badge session-logged-out">🔒 Not Logged In</span>;
  }
  return <span className="session-badge session-unknown">🌐 Session</span>;
}

function ActionBadge({ action }) {
  const labels = {
    login: "🔑 Login",
    logout: "🚪 Logout",
    register: "📝 Register",
    browse: "🌐 Browse",
    search: "🔍 Search",
    profile: "👤 Profile",
    interact: "💬 Interact",
    status: "📊 Status",
    storeCredentials: "🔐 Credentials",
    verify_email: "✉️ Email Verify",
    submitForm: "📋 Form Submit",
    setCredentials: "🔐 Credentials",
    extractLinks: "🔗 Links",
    extractForms: "📄 Forms",
    extractText: "📝 Text"
  };

  return <span className="action-badge">{labels[action] || `🌐 ${action || "Browse"}`}</span>;
}

function LinksList({ links }) {
  const [expanded, setExpanded] = useState(false);
  if (!links || links.length === 0) return null;

  const displayed = expanded ? links : links.slice(0, 10);

  return (
    <div className="web-links-section">
      <h4 className="web-section-header" onClick={() => setExpanded(!expanded)}>
        🔗 Links ({links.length}) {links.length > 10 && <span className="toggle-hint">{expanded ? "▲ collapse" : "▼ show all"}</span>}
      </h4>
      <ul className="web-links-list">
        {displayed.map((link, i) => (
          <li key={i} className="web-link-item">
            <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
              {link.text || link.url}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FormsList({ forms }) {
  if (!forms || forms.length === 0) return null;

  return (
    <div className="web-forms-section">
      <h4 className="web-section-header">📋 Forms ({forms.length})</h4>
      {forms.map((form, i) => (
        <div key={i} className="web-form-card">
          <div className="web-form-header">
            <span className="form-method">{form.method}</span>
            <span className="form-action">{form.action}</span>
          </div>
          <table className="web-form-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Required</th>
              </tr>
            </thead>
            <tbody>
              {form.fields.filter(f => f.type !== "hidden").map((field, j) => (
                <tr key={j}>
                  <td>{field.name}</td>
                  <td><code>{field.type}</code></td>
                  <td>{field.required ? "✅" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function ErrorMessages({ errors }) {
  if (!errors || errors.length === 0) return null;
  return (
    <div className="web-errors">
      {errors.map((err, i) => (
        <div key={i} className="web-error-msg">⚠️ {err}</div>
      ))}
    </div>
  );
}

function SuccessMessages({ successes }) {
  if (!successes || successes.length === 0) return null;
  return (
    <div className="web-successes">
      {successes.map((msg, i) => (
        <div key={i} className="web-success-msg">✅ {msg}</div>
      ))}
    </div>
  );
}

export default function WebBrowserPanel({ content, data }) {
  const [showContent, setShowContent] = useState(false);

  if (!data) {
    return <div className="message-text">{content}</div>;
  }

  const { title, url, action, loginStatus, sessionActive, statusCode,
    links, forms, errors, successes, query, needsCredentials,
    mode, fields, session } = data;

  // Registration preview mode
  if (mode === "preview" && fields) {
    return (
      <div className="web-browser-panel">
        <div className="web-page-header">
          <ActionBadge action={action} />
          <h3 className="web-page-title">{title || "Registration Form"}</h3>
        </div>
        <div className="web-preview-notice">
          📝 Registration form found. Provide your details to proceed.
        </div>
        <table className="web-form-table">
          <thead>
            <tr><th>Field</th><th>Type</th><th>Required</th></tr>
          </thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={i}>
                <td>{f.name}</td>
                <td><code>{f.type}</code></td>
                <td>{f.required ? "✅" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="message-text">{content}</div>
      </div>
    );
  }

  // Needs credentials prompt
  if (needsCredentials) {
    return (
      <div className="web-browser-panel">
        <div className="web-page-header">
          <ActionBadge action={action} />
          <span className="session-badge session-logged-out">🔒 Credentials Needed</span>
        </div>
        <div className="web-credential-notice">
          🔑 No credentials available. Provide them in your message or store them first.
        </div>
        <div className="message-text">{content}</div>
      </div>
    );
  }

  return (
    <div className="web-browser-panel">
      {/* Header */}
      <div className="web-page-header">
        <ActionBadge action={action} />
        <SessionBadge loginStatus={loginStatus} sessionActive={sessionActive} />
        {statusCode && <span className="status-code-badge">HTTP {statusCode}</span>}
        {session && <span className="session-name-badge">📁 {session}</span>}
      </div>

      {/* Title and URL */}
      {title && <h3 className="web-page-title">{title}</h3>}
      {url && (
        <a className="web-page-url" href={url} target="_blank" rel="noopener noreferrer">
          {url.length > 80 ? url.slice(0, 80) + "..." : url}
        </a>
      )}

      {/* Search query */}
      {query && <div className="web-search-query">Search: "{query}"</div>}

      {/* Status messages */}
      <ErrorMessages errors={errors} />
      <SuccessMessages successes={successes} />

      {/* Main content (text summary from LLM) */}
      <div className="message-text">{content}</div>

      {/* Page content (expandable) */}
      {data.content && data.content.length > 200 && (
        <div className="web-content-section">
          <button
            className="web-toggle-btn"
            onClick={() => setShowContent(!showContent)}
          >
            {showContent ? "▲ Hide page content" : "▼ Show page content"}
          </button>
          {showContent && (
            <pre className="web-content-area">{data.content}</pre>
          )}
        </div>
      )}

      {/* Links */}
      <LinksList links={links} />

      {/* Forms */}
      <FormsList forms={forms} />
    </div>
  );
}

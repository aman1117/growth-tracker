//! API documentation at `/swagger/*` (replaces `gofiber/swagger`): `/swagger` and `/swagger/`
//! redirect to `/swagger/index.html`, which renders Swagger UI for `/swagger/doc.json`.
//! The OpenAPI document is the one previously generated from the Go handlers
//! (`backend/docs/swagger.json`); the API contract did not change in the rewrite.

use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

const DOC_JSON: &str = include_str!("../../../docs/swagger.json");

const INDEX_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Swagger UI</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>html{box-sizing:border-box;overflow-y:scroll}*,*:before,*:after{box-sizing:inherit}body{margin:0;background:#fafafa}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" charset="UTF-8"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js" charset="UTF-8"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: "/swagger/doc.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        plugins: [SwaggerUIBundle.plugins.DownloadUrl],
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>
"##;

/// Routes serving the documentation.
pub fn routes() -> Router {
    Router::new()
        .route("/swagger", get(redirect_to_index))
        .route("/swagger/", get(redirect_to_index))
        .route("/swagger/{*path}", get(serve))
}

async fn redirect_to_index() -> Response {
    (StatusCode::MOVED_PERMANENTLY, [(header::LOCATION, HeaderValue::from_static("/swagger/index.html"))])
        .into_response()
}

async fn serve(Path(path): Path<String>) -> Response {
    match path.as_str() {
        "index.html" => ([(header::CONTENT_TYPE, HeaderValue::from_static("text/html"))], INDEX_HTML).into_response(),
        "doc.json" => {
            ([(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], DOC_JSON).into_response()
        }
        "" => redirect_to_index().await,
        _ => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn serves_doc_and_redirects() {
        let resp = routes().oneshot(Request::get("/swagger/doc.json").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let resp = routes().oneshot(Request::get("/swagger").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::MOVED_PERMANENTLY);
        assert_eq!(resp.headers()["location"], "/swagger/index.html");
        assert!(serde_json::from_str::<serde_json::Value>(DOC_JSON).is_ok());
    }
}

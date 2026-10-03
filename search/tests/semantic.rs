//! Needs the embedding model on disk, so it only runs when pointed at it:
//! RIFF_SEARCH_MODEL_DIR=<dir with model_quantized.onnx + tokenizer.json> cargo test -p riff-search --test semantic

use riff_search::{Document, Embedder, Index, Query, Segment, DEFAULT_MODEL};
use std::path::PathBuf;
use std::sync::Arc;

fn doc(key: &str, title: &str, lines: &[&str]) -> Document {
    Document {
        key: key.into(),
        kind: "transcript".into(),
        title: title.into(),
        group: None,
        date: None,
        meta: serde_json::Value::Null,
        fingerprint: key.into(),
        segments: lines
            .iter()
            .enumerate()
            .map(|(i, l)| Segment { text: l.to_string(), start: Some(i as f64), ..Default::default() })
            .collect(),
    }
}

#[tokio::test]
async fn finds_by_meaning_and_ignores_nonsense() {
    let Ok(dir) = std::env::var("RIFF_SEARCH_MODEL_DIR") else {
        eprintln!("RIFF_SEARCH_MODEL_DIR not set; skipping");
        return;
    };
    let embedder = Embedder::load(&PathBuf::from(dir), &DEFAULT_MODEL).expect("model loads");
    let index = Index::open_in_memory().await.unwrap();
    index.set_embedder(Some(Arc::new(embedder))).await.unwrap();
    index
        .sync_scope(
            "s",
            &[
                doc("launch", "Product sync", &["We agreed to move the release back by two weeks because QA found blockers."]),
                doc("money", "Finance review", &["Travel spending gets cut ten percent next quarter."]),
                doc("people", "Team standup", &["Priya will interview the two backend candidates on Thursday."]),
                doc("es", "Reunión de ventas", &["El cliente quiere un descuento en la renovación del contrato anual."]),
            ],
        )
        .await
        .unwrap();
    assert_eq!(index.embed_pending(usize::MAX).await.unwrap(), 4);

    let search = |text: &str| {
        let q = Query { text: text.into(), scopes: vec!["s".into()], kinds: vec![], limit: 5, grouped: true };
        let index = &index;
        async move { index.search(&q).await.unwrap() }
    };
    // No shared words with the matching chunk.
    for (question, expected) in [
        ("when did we decide to delay the launch?", "launch"),
        ("budget reductions", "money"),
        ("who is hiring engineers", "people"),
        ("customer asked for a price reduction", "es"),
    ] {
        let hits = search(question).await;
        assert_eq!(hits.first().map(|h| h.key.as_str()), Some(expected), "{question}: {hits:#?}");
        assert!(hits[0].semantic);
    }
    let nonsense = search("purple giraffe trampoline").await;
    assert!(nonsense.is_empty(), "{nonsense:#?}");
}

import json

from app.services import avanza_service as avanza_module


def test_add_manual_mapping_persists_to_local_store_without_github(monkeypatch, tmp_path):
    monkeypatch.setattr(avanza_module, "MAPPING_DIR", str(tmp_path))

    service = avanza_module.AvanzaService()
    created = service.add_manual_mapping("Volvo, ser. B", "VOLV-B.ST", "5269")

    assert created.yahoo_ticker == "VOLV-B.ST"
    assert created.instrument_id == "5269"
    assert service.get_mapping_by_ticker("VOLV-B.ST") is not None

    saved = json.loads((tmp_path / avanza_module.MAPPING_FILE).read_text(encoding="utf-8"))
    assert saved["mappings"][0]["avanza_name"] == "Volvo, ser. B"
    assert saved["mappings"][0]["yahoo_ticker"] == "VOLV-B.ST"


def test_ensure_mapping_for_ticker_returns_existing_mapping(monkeypatch, tmp_path):
    monkeypatch.setattr(avanza_module, "MAPPING_DIR", str(tmp_path))

    service = avanza_module.AvanzaService()
    service.add_manual_mapping("Investor ser. B", "INVE-B.ST", "5247")

    mapping = service.ensure_mapping_for_ticker("INVE-B.ST")

    assert mapping is not None
    assert mapping.avanza_name == "Investor ser. B"
    assert mapping.instrument_id == "5247"

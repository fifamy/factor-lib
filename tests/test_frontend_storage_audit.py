from scripts.audit_frontend_storage import audit


def test_storage_audit_separates_missing_identical_and_different_files(tmp_path):
    source, published = tmp_path / "source", tmp_path / "published"
    source.mkdir()
    published.mkdir()
    for name, local, remote in [("equal", b"ab", b"ab"), ("changed", b"ab", b"cd"),
                                ("local", b"xyz", None)]:
        (source / name).write_bytes(local)
        if remote is not None:
            (published / name).write_bytes(remote)
    (published / "remote").write_bytes(b"r")
    before = {path.name: path.read_bytes() for path in source.iterdir()}
    report = audit(source, published, verify_hashes=True)
    group = report["groups"]["(root files)"]
    assert report["local_bytes"] == 7
    assert report["local_only_bytes"] == 3
    assert group["identical_files"] == group["different_files"] == group["local_only_files"] == 1
    assert report["published_only_files"] == ["remote"]
    assert before == {path.name: path.read_bytes() for path in source.iterdir()}
    quick = audit(source, published)
    assert quick["groups"]["(root files)"]["unverified_files"] == 2


def test_storage_audit_ignores_hidden_files_and_symlinks(tmp_path):
    source, published = tmp_path / "source", tmp_path / "published"
    source.mkdir()
    published.mkdir()
    (source / ".private").write_bytes(b"secret")
    outside = tmp_path / "outside"
    outside.write_bytes(b"do not follow")
    (source / "link").symlink_to(outside)
    (source / "dirlink").symlink_to(published, target_is_directory=True)
    assert audit(source, published)["local_bytes"] == 0

package com.ourdrop.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Serves received files from the public Downloads folder through
 * content:// URIs, so other apps (gallery, video player, PDF viewer)
 * can preview them without ever seeing a raw filesystem path. Only a
 * bare file name is accepted — path traversal is impossible.
 */
public class OdFileProvider extends ContentProvider {

    @Override
    public boolean onCreate() {
        return true;
    }

    private File resolve(Uri uri) {
        String name = uri.getLastPathSegment() == null ? "" : Uri.decode(uri.getLastPathSegment());
        if (name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..")) {
            return null;
        }
        File f = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name);
        return f.isFile() ? f : null;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        if (f == null) throw new FileNotFoundException(String.valueOf(uri));
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        String name = uri.getLastPathSegment() == null ? "" : uri.getLastPathSegment();
        String ext = MimeTypeMap.getFileExtensionFromUrl(name);
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return mime == null ? "application/octet-stream" : mime;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}

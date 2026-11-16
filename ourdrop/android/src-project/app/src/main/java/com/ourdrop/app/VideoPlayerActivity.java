package com.ourdrop.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.MediaController;
import android.widget.Toast;
import android.widget.VideoView;

/** Integrated video preview (playback controls via MediaController). */
public class VideoPlayerActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_video_player);
        String name = getIntent().getStringExtra("name");
        if (name == null) {
            finish();
            return;
        }
        Uri uri = Uri.parse("content://com.ourdrop.app.files/" + Uri.encode(name));
        VideoView video = findViewById(R.id.videoView);
        MediaController mc = new MediaController(this);
        mc.setAnchorView(video);
        video.setMediaController(mc);
        video.setVideoURI(uri);
        video.setOnPreparedListener(mp -> video.start());
        video.setOnErrorListener((mp, what, extra) -> {
            // The built-in player cannot decode this format: hand the file
            // to an external app instead of failing silently.
            Toast.makeText(this, "This video format needs another player", Toast.LENGTH_SHORT).show();
            try {
                Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(uri, "video/*");
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(view, "Open with"));
            } catch (ActivityNotFoundException ignored) {}
            finish();
            return true;
        });
    }
}

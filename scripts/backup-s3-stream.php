<?php
// Run with `docker exec -i <backend> php < scripts/backup-s3-stream.php`.
// A logical S3 archive avoids copying SeaweedFS's mutable database/index files.
// No credentials, object names, or customer contents are written to stderr.
declare(strict_types=1);
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

function emitTarHeader(string $name, int $size): void
{
    if (strlen($name) > 100 || $size < 0 || $size > 8589934591) {
        throw new RuntimeException('Unsupported archive entry');
    }
    $header = str_pad($name, 100, "\0") . "0000600\0" . "0000000\0" . "0000000\0"
        . sprintf("%011o\0", $size) . sprintf("%011o\0", 0) . str_repeat(' ', 8)
        . '0' . str_repeat("\0", 100) . "ustar\00000" . str_repeat("\0", 32 + 32 + 8 + 8 + 155 + 12);
    if (strlen($header) !== 512) throw new RuntimeException('Invalid tar header');
    $checksum = array_sum(unpack('C*', $header));
    $header = substr_replace($header, sprintf("%06o\0 ", $checksum), 148, 8);
    echo $header;
}

try {
    $disk = Illuminate\Support\Facades\Storage::disk('s3');
    $client = $disk->getClient();
    $manifest = ['format' => 'hive-s3-logical-v1', 'started_at' => gmdate('c'), 'buckets' => [], 'objects' => []];
    $buckets = array_column($client->listBuckets()['Buckets'] ?? [], 'Name');
    sort($buckets, SORT_STRING);
    foreach ($buckets as $bucket) {
        $manifest['buckets'][] = $bucket;
        foreach ($client->getPaginator('ListObjectsV2', ['Bucket' => $bucket]) as $page) {
            foreach ($page['Contents'] ?? [] as $object) {
                $result = $client->getObject(['Bucket' => $bucket, 'Key' => $object['Key'], 'IfMatch' => $object['ETag']]);
                $size = (int) $result['ContentLength'];
                $entry = 'objects/' . hash('sha256', $bucket . "\0" . $object['Key']);
                emitTarHeader($entry, $size);
                $body = $result['Body'];
                $hash = hash_init('sha256');
                $written = 0;
                while (!$body->eof()) {
                    $chunk = $body->read(1048576);
                    if ($chunk === '' && !$body->eof()) throw new RuntimeException('Stalled object stream');
                    $written += strlen($chunk);
                    hash_update($hash, $chunk);
                    echo $chunk;
                }
                if ($written !== $size) throw new RuntimeException('Object size changed');
                echo str_repeat("\0", (512 - ($size % 512)) % 512);
                $manifest['objects'][] = ['bucket' => $bucket, 'key' => $object['Key'], 'entry' => $entry,
                    'bytes' => $size, 'sha256' => hash_final($hash), 'content_type' => $result['ContentType'] ?? null,
                    'cache_control' => $result['CacheControl'] ?? null, 'metadata' => $result['Metadata'] ?? []];
            }
        }
    }
    $manifest['finished_at'] = gmdate('c');
    $json = json_encode($manifest, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    emitTarHeader('manifest.json', strlen($json));
    echo $json, str_repeat("\0", (512 - (strlen($json) % 512)) % 512), str_repeat("\0", 1024);
} catch (Throwable $error) {
    fwrite(STDERR, "Hive object backup failed; inspect privately. No complete archive was confirmed.\n");
    exit(1);
}

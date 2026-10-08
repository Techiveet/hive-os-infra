<?php
// Run with `docker exec -i <backend> php < scripts/backup-s3-stream.php`.
// A logical S3 archive avoids copying SeaweedFS's mutable database/index files.
// No credentials, object names, or customer contents are written to stderr.
declare(strict_types=1);

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

function s3RequestWithRetry(Aws\S3\S3Client &$client, string $operation, array $arguments): Aws\Result
{
    // Coolify can replace the storage container during a release. Retry only
    // transport/transient errors, never credentials, missing keys or ETag
    // mismatches; rebuild the HTTP handler to discard a stale cached Docker IP.
    for ($attempt = 0; ; $attempt++) {
        try {
            return $client->{$operation}($arguments);
        } catch (Aws\S3\Exception\S3Exception $error) {
            $status = $error->getStatusCode() ?? 0;
            if ($attempt >= 60 || !in_array($status, [0, 408, 429, 500, 502, 503, 504], true)) throw $error;
            if ($attempt === 0) fwrite(STDERR, "Hive object backup: retrying transient storage interruption.\n");
            sleep(5);
            $client = rebuildBackupS3Client($client);
        }
    }
}

function rebuildBackupS3Client(Aws\S3\S3Client $client): Aws\S3\S3Client
{
    // getConfig() is not a round-trippable constructor argument array: it
    // omits required service/version inputs. Rebuild from explicit public API
    // properties while retaining the resolved credentials privately.
    return new Aws\S3\S3Client([
        'version' => 'latest', 'region' => $client->getRegion(),
        'endpoint' => (string) $client->getEndpoint(),
        'credentials' => $client->getCredentials()->wait(),
        'use_path_style_endpoint' => (bool) $client->getConfig('use_path_style_endpoint'),
        'http' => ['connect_timeout' => 5, 'timeout' => 120], 'retries' => 0,
    ]);
}

$phase = 'bootstrap';
try {
    require '/var/www/html/vendor/autoload.php';
    $app = require '/var/www/html/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    $disk = Illuminate\Support\Facades\Storage::disk('s3');
    $client = rebuildBackupS3Client($disk->getClient());
    $manifest = ['format' => 'hive-s3-logical-v1', 'started_at' => gmdate('c'), 'buckets' => [], 'objects' => []];
    $phase = 'list_buckets';
    $buckets = array_column(s3RequestWithRetry($client, 'listBuckets', [])['Buckets'] ?? [], 'Name');
    sort($buckets, SORT_STRING);
    foreach ($buckets as $bucket) {
        $manifest['buckets'][] = $bucket;
        $phase = 'list_objects';
        $continuation = null;
        do {
            $listArguments = ['Bucket' => $bucket];
            if ($continuation !== null) $listArguments['ContinuationToken'] = $continuation;
            $page = s3RequestWithRetry($client, 'listObjectsV2', $listArguments);
            foreach ($page['Contents'] ?? [] as $object) {
                $phase = 'read_object';
                $result = s3RequestWithRetry($client, 'getObject', ['Bucket' => $bucket, 'Key' => $object['Key'], 'IfMatch' => $object['ETag']]);
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
            $continuation = !empty($page['IsTruncated']) ? ($page['NextContinuationToken'] ?? null) : null;
            if (!empty($page['IsTruncated']) && $continuation === null) throw new RuntimeException('Missing continuation token');
        } while ($continuation !== null);
    }
    $manifest['finished_at'] = gmdate('c');
    $json = json_encode($manifest, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    emitTarHeader('manifest.json', strlen($json));
    echo $json, str_repeat("\0", (512 - (strlen($json) % 512)) % 512), str_repeat("\0", 1024);
} catch (Throwable $error) {
    $status = $error instanceof Aws\Exception\AwsException ? ($error->getStatusCode() ?? 0) : 0;
    fwrite(STDERR, "Hive object backup failed at {$phase}; class=" . get_class($error) . "; HTTP={$status}. No complete archive confirmed.\n");
    exit(1);
}

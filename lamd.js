const os = require('os')
const fs = require('fs')
const http = require('http')
const LivemeAPI = require('liveme-api')
const LiveMe = new LivemeAPI()
const ffmpeg = require('fluent-ffmpeg')
const m3u8stream = require('./modules/m3u8stream')

let config = {
    downloaderFFMPEG: true,
    downloadPath: os.homedir() + '/Downloads',
    downloadChunks: 10,
    downloadTemplate: '%%replayid%%',
    loopCycle: 30,
    localPort: 8280,
    console_output: true
}

let accounts = []
let accountIndex = 0
let downloadList = []
let erroredList = []
let downloadActive = false
let minuteTick = 0
let APIVERSION = '1.1'

main()

function main () {
    /**
     * Load account file
     */
    if (!fs.existsSync('account.json')) {
        process.stdout.write('\x1b[1;34mMissing file: account.json\n')
        throw new Error('Missing file: account.json')
    }
    const acc = JSON.parse(fs.readFileSync('account.json'))
    if (!acc.email || !acc.password || !acc.email.length || !acc.password.length) {
        process.stdout.write('\x1b[1;34mAuthentication Error. Please make sure you have set your email and password correctly in "account.json" file.\n')
        throw new Error('Authentication Error. Please make sure you have set your email and password correctly in "account.json" file.')
    }
    /**
     * Check if authenticated
     */
    if (!LiveMe.user || !LiveMe.user.length) {
        return LiveMe.setAuthDetails(acc.email, acc.password)
            .then(() => main())
            .catch(error => {
                process.stdout.write(`\x1b[1;34mAuthentication Error. (${JSON.stringify(error)})\n`)
                throw new Error(`Authentication Error. (${JSON.stringify(error)})`)
            })
    }
    /**
     * Load config file
     */
    if (fs.existsSync('config.json')) {
        fs.readFile('config.json', 'utf8', (err, data) => {
            if (!err) {
                config = JSON.parse(data)

                // These options only come int play when using the stream downloader and not FFMPEG
                if ((config.downloaderFFMPEG === undefined) || (config.downloaderFFMPEG === null)) config.downloaderFFMPEG = true
                if (config.downloadChunks < 2) config.downloadChunks = 2
                if (config.downloadChunks > 250) config.downloadChunks = 250

                if (config.loopCycle > 360) config.loopCycle = 360
                if (config.loopCycle < 15) config.loopCycle = 15

                if ((config.console_output === undefined) || (config.console_output === null)) config.console_output = false
            }

            if (config.console_output) {
                process.stdout.write('\x1b[1;34mLiveMe Account Monitor Daemon (LAMD)\n\x1b[0;34mhttps://thecoderstoolbox.com/lamd\n')
                process.stdout.write('\x1b[1;30m------------------------------------------------------------------------------\n')
                process.stdout.write('\x1b[1;32m     Scan Interval:      \x1b[1;36m' + config.loopCycle + ' \x1b[1;32mminutes\n\n')

                process.stdout.write('\x1b[1;32m     Download Path:      \x1b[1;36m' + config.downloadPath + '\n')
                process.stdout.write('\x1b[1;32m     Download Template:  \x1b[1;36m' + config.downloadTemplate + '\n\n')
                process.stdout.write('\x1b[1;32m     Download Engine:    \x1b[1;36m' + (config.downloaderFFMPEG ? 'FFMPEG' : 'Stream Downloader') + '\n')
                if (config.downloaderFFMPEG === false) {
                    process.stdout.write('\x1b[1;32m     Download Chunks:    \x1b[1;36m' + config.downloadChunks + '\x1b[1;32m at a time\n')
                }
                process.stdout.write('\x1b[1;30m------------------------------------------------------------------------------\n')
                process.stdout.write('\x1b[0;37m')
            }
        })
    }

    for (var i = 0; i < process.argv.length; i++) {
        if (process.argv[i] === '--writecfg') {
            fs.writeFile(
                'config.json',
                JSON.stringify(config, null, 2),
                () => {}
            )
        }
    }

    /**
     * Load acc list
     */
    if (fs.existsSync('accounts.json')) {
        fs.readFile('accounts.json', 'utf8', (err, data) => {
            if (!err) {
                accounts = JSON.parse(data)

                if (config.console_output) {
                    process.stdout.write('\x1b[1;33m' + accounts.length + ' \x1b[1;34maccounts loaded in.\n')
                }
            }
        })
    }

    if (fs.existsSync('queued.json')) {
        fs.readFile('queued.json', 'utf8', (err, data) => {
            if (!err) {
                downloadList = JSON.parse(data)

                if (downloadList.length > 0) {
                    if (config.console_output) process.stdout.write('\x1b[1;33mResuming existing download queue...\n')

                    setTimeout(() => {
                        downloadFile()
                    }, 5000)
                }
            }
        })
    }

    /**
     * Replay Check Interval - Runs every minute
     */
    setInterval(() => {
        minuteTick++
        if (minuteTick === config.loopCycle) {
            minuteTick = 0
            setImmediate(() => {
                accountIndex = 0
                accountScanLoop()
            })
        }
    }, 60000)

    setTimeout(() => {
        accountIndex = 0
        accountScanLoop()
    }, 5)

    /**
     * Internal Web Server - Used for command interface
     */
    http.createServer((req, res) => {
        let chunks = req.url.substr(1).split('/')
        let response = {
            api_version: APIVERSION,
            code: 500,
            message: '',
            data: null
        }

        switch (chunks[0]) {
        case 'add-user':
        case 'add-account':
            let addThis = true
            let i = 0
            let isnum = /^\d+$/.test(chunks[1])

            for (i = 0; i < accounts.length; i++) {
                if (accounts[i].userid === chunks[1]) { addThis = false }
            }

            if (addThis && isnum) {
                accounts.push({
                    userid: chunks[1],
                    scanned: Math.floor((new Date()).getTime() / 1000)
                })

                fs.writeFile(
                    'accounts.json',
                    JSON.stringify(accounts),
                    () => {}
                )

                response.message = 'Account added.'
                response.code = 200
                if (config.console_output) process.stdout.write('\x1b1;36mAdded \x1b[1;33m' + chunks[1] + ' \x1b[1;36mfor monitoring.\n')
            } else {
                response.message = 'Account already in list.'
                response.code = 302
                if (config.console_output) process.stdout.write('\x1b[1;31mAccount \x1b[1;33m' + chunks[1] + ' \x1b[1;31malready in database.\n')
            }
            break

        case 'check-user':
        case 'check-account':
            let isPresent = false

            for (let i = 0; i < accounts.length; i++) {
                if (accounts[i].userid === chunks[1]) { isPresent = true }
            }

            response.message = isPresent ? 'Account is in the list.' : 'Account not found in the list.'
            response.data = []
            response.code = isPresent ? 200 : 404
            break

        case 'remove-user':
        case 'remove-account':
            response.message = 'Account not in the list.'
            response.code = 404

            for (let i = 0; i < accounts.length; i++) {
                if (accounts[i].userid === chunks[1]) {
                    accounts.splice(i, 1)
                    response.message = 'Account removed.'
                    response.code = 200
                    if (config.console_output) process.stdout.write('\x1b[1;36mAccount \x1b[1;33m' + chunks[1] + ' \x1b[1;36mremoved from list.\n')
                }
            }

            fs.writeFile(
                'accounts.json',
                JSON.stringify(accounts),
                () => {}
            )
            break

        case 'list-users':
        case 'list-accounts':
            response.message = 'Accounts in list'
            response.code = 200
            response.data = []
            for (let i = 0; i < accounts.length; i++) {
                response.data.push(accounts[i].userid)
            }
            break

        case 'add-replay':
        case 'add-download':
            response.message = 'Replay added to queue.'
            response.code = 200
            response.data = []
            let isNum = /^\d+$/.test(chunks[1])
            if (isNum) {
                if (config.console_output) process.stdout.write('\x1b[1;36mReplay \x1b[1;33m' + chunks[1] + ' \x1b[1;36m- added to queue.  \r')
                downloadList.push(chunks[1])
                downloadFile()
            }
            break

        case 'ping':
            response.message = 'Pong'
            response.code = 200
            break

        case 'shutdown':
            if (config.console_output) process.stdout.write('\x1b[1;31mShutting down and storing information...\n')

            setTimeout(() => {
                process.exit(0)
            }, 250)

            break

        default:
            response.message = 'Invalid command.'
            break
        }

        res.writeHead(200, { 'Content-Type': 'text/javascript' })
        res.write(JSON.stringify(response, null, 2))
        res.end()
    }).listen(config.localPort)
}

/**
 * Account Scan Loop
 */
function accountScanLoop () {
    if (accountIndex < accounts.length) {
        setTimeout(() => {
            accountScanLoop()
        }, 250)
    }

    setImmediate(function () {
        if (accountIndex < accounts.length) { accountIndex++; scanForNewReplays(accountIndex) }
    })
}

/**
 * Replay Scan
 */
function scanForNewReplays (i) {
    if (accounts[i] === undefined) return

    LiveMe.getUserReplays(accounts[i].userid, 1, 10).then(replays => {
        if (replays === undefined) return
        if (replays.length < 1) return

        let ii = 0
        let count = 0
        let userid = replays[0].userid
        let lastScanned = 0
        let dt = Math.floor((new Date()).getTime() / 1000)

        lastScanned = accounts[i].scanned
        accounts[i].scanned = dt

        fs.writeFile(
            'accounts.json',
            JSON.stringify(accounts),
            () => {}
        )

        var replayCount = 0
        for (ii = 0; ii < replays.length; ii++) {
            // If we take the video time and subtract the last time we scanned and its
            // greater than zero then its new and needs to be added
            if ((replays[ii].vtime - lastScanned) > 0) {
                var addReplay = true
                for (var j = 0; j < downloadList.length; j++) {
                    if (downloadList[j] === replays[ii].vid) addReplay = false
                }
                if (addReplay === true) {
                    replayCount++
                    downloadList.push(replays[ii].vid)
                    fs.writeFile(
                        'queued.json',
                        JSON.stringify(downloadList),
                        () => {
                            // Queue file was written
                        }
                    )
                }
            }
        }

        if (replayCount > 0) {
            if (config.console_output) process.stdout.write('\x1b[1;36mAdding \x1b[1;33m' + replayCount + ' \x1b[1;36mreplays for \x1b[1;33m' + userid + '        \n')
            downloadFile()
        } else {
            if (config.console_output) process.stdout.write('\x1b[1;36mNo new replays found for \x1b[1;33m' + userid + '\x1b[1;36m.                            \n')
        }
    })
}

/**
 * Download Handler
 */
function downloadFile () {
    if (downloadActive === true) return
    if (downloadList.length === 0) return

    LiveMe.getVideoInfo(downloadList[0]).then(video => {
        let dt = new Date(video.vtime * 1000)
        let mm = dt.getMonth() + 1
        let dd = dt.getDate()
        let filename = ''

        filename = config.downloadTemplate
            .replace(/%%broadcaster%%/g, video.uname)
            .replace(/%%longid%%/g, video.userid)
            .replace(/%%replayid%%/g, video.vid)
            .replace(/%%replayviews%%/g, video.playnumber)
            .replace(/%%replaylikes%%/g, video.likenum)
            .replace(/%%replayshares%%/g, video.sharenum)
            .replace(/%%replaytitle%%/g, video.title ? video.title : 'untitled')
            .replace(/%%replayduration%%/g, video.videolength)
            .replace(/%%replaydatepacked%%/g, (dt.getFullYear() + (mm < 10 ? '0' : '') + mm + (dd < 10 ? '0' : '') + dd))
            .replace(/%%replaydateus%%/g, ((mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd + '-' + dt.getFullYear()))
            .replace(/%%replaydateeu%%/g, ((dd < 10 ? '0' : '') + dd + '-' + (mm < 10 ? '0' : '') + mm + '-' + dt.getFullYear()))

        // Cleanup any illegal characters in the filename
        filename = filename.replace(/[/\\?%*:|"<>]/g, '-')
        filename = filename.replace(/([^a-z0-9\s]+)/gi, '-')
        filename = filename.replace(/[\u{0080}-\u{FFFF}]/gu, '')

        if (config.downloaderFFMPEG === true) {
            filename += '.mp4'

            ffmpeg(video.hlsvideosource)
                .outputOptions([
                    '-c copy',
                    '-bsf:a aac_adtstoasc',
                    '-vsync 2',
                    '-movflags faststart'
                ])
                .output(config.downloadPath + '/' + filename)
                .on('end', function (stdout, stderr) {
                    if (config.console_output) process.stdout.write('\x1b[1;34mReplay \x1b[1;33m' + downloadList[0] + ' \x1b[1;34m- downloaded.                   \n')

                    downloadList.shift()
                    downloadActive = false

                    // Update current queue file
                    fs.writeFile(
                        'queued.json',
                        JSON.stringify(downloadList),
                        () => {

                        }
                    )

                    downloadFile()
                })
                .on('progress', function (progress) {
                    if (config.console_output) process.stdout.write('\x1b[1;34mReplay \x1b[1;33m' + downloadList[0] + ' \x1b[1;34m- \x1b[1;33m' + progress.percent.toFixed(2) + '%     \r')
                })
                .on('start', function (c) {
                    downloadActive = true
                })
                .on('error', function (err, stdout, exterr) {
                    if (config.console_output) process.stdout.write('\x1b[1;34mReplay \x1b[1;33m' + downloadList[0] + ' \x1b[1;34m- \x1b[1;31mErrored \x1b[1;36m(\x1b[1;34mDetails: \x1b[1;37m' + err + '\x1b[1;36m)   \n')

                    erroredList.push(downloadList[0])
                    downloadList.shift()
                    downloadActive = false

                    // Update current queue file
                    fs.writeFile(
                        'queued.json',
                        JSON.stringify(downloadList),
                        () => {
                            // Queue file was written
                        }
                    )

                    // Update errored file
                    fs.writeFile(
                        'errored.json',
                        erroredList.join('\n'),
                        () => {
                            // Errored file was written
                        }
                    )

                    downloadFile()
                })
                .run()
        } else {
            filename += '.ts'

            m3u8stream(video, {
                chunkReadahead: config.downloadChunks,
                on_progress: (e) => {
                    var p = Math.floor((e.index / e.total) * 10000) / 100
                    if (config.console_output) process.stdout.write('\x1b[1;34mReplay \x1b[1;33m' + downloadList[0] + ' \x1b[1;34m- \x1b[1;33m' + p + '%               \r')
                },
                on_complete: (e) => {
                    if (config.console_output) process.stdout.write('\x1b[1;34mReplay \x1b[1;33m' + downloadList[0] + ' \x1b[1;34m- downloaded.                   \n')

                    downloadList.shift()
                    downloadActive = false

                    // Update current queue file
                    fs.writeFile(
                        'queued.json',
                        JSON.stringify(downloadList),
                        () => {

                        }
                    )

                    downloadFile()
                },
                on_error: (e) => {
                    // We ignore the timeout errors to avoid issues.
                    if (e.error === 'Download timeout') return

                    if (config.console_output) process.stdout.write('\x1b[1;34mReplay \x1b[1;33m' + downloadList[0] + ' \x1b[1;34m- \x1b[1;31mErrored \x1b[1;36m(\x1b[1;34mDetails: \x1b[1;37m' + err + '\x1b[1;36m)   \n')

                    erroredList.push(downloadList[0])
                    downloadList.shift()
                    downloadActive = false

                    // Update current queue file
                    fs.writeFile(
                        'queued.json',
                        JSON.stringify(downloadList),
                        () => {
                            // Queue file was written
                        }
                    )

                    // Update errored file
                    fs.writeFile(
                        'errored.json',
                        erroredList.join('\n'),
                        () => {
                            // Errored file was written
                        }
                    )

                    downloadFile()
                }
            }).pipe(fs.createWriteStream(config.downloadPath + '/' + filename))
        }
    })
}

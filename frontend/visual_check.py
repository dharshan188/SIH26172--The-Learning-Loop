import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

OUTPUT = Path(__file__).parent / 'screenshots'
OUTPUT.mkdir(exist_ok=True)
PAGES = ['home', 'live-monitor', 'model-comparison', 'dataset']
BASE_URL = os.environ.get('MARVIN_FRONTEND_URL', 'http://127.0.0.1:5174')


def verify_backend(browser):
    test_page = browser.new_page(viewport={'width': 1536, 'height': 1024})
    commands, sockets = [], []
    snapshot = {
        'type': 'snapshot', 'esp32_connected': True, 'esp32_online': True, 'asr_online': True, 'asr_status': 'ONLINE',
        'model_version': 'MARVIN_BASELINE_CASCADE',
        'metrics': {'type': 'kws', 's1': 0.75, 's2': 0.8, 's1_score': 0.75, 's2_score': 0.8, 'stage2_invoked': True, 'wake': True,
                    'free_heap': None, 'min_free_heap': None, 's1_ms': 12.3,
                    's2_ms': 4.5, 's1_latency_ms': 12.3, 's2_latency_ms': 4.5, 'cpu_duty_percent': 6.2},
        'history': [{'id': 'test-only', 'text': 'Integration test transcript', 'at': '12:00:00', 'duration_s': 2}],
        'score_history': [{'s1': 0.2, 's2': 0.1, 'stage2_invoked': False, 'at': 100},
                          {'s1': 0.75, 's2': 0.8, 'stage2_invoked': True, 'at': 101}],
        'dataset': {'counts': {'positive_marvin': 10, 'normal_speech': 20,
                              'background_noise': 30, 'hard_negative': 40,
                              'final_positive': 5, 'final_negative': 6}},
        'kws_test': {'active': False},
    }

    def handle_socket(socket):
        sockets.append(socket)
        socket.on_message(lambda message: commands.append(json.loads(message)['command']))
        socket.send(json.dumps(snapshot))

    test_page.route_web_socket('**/ws/dashboard', handle_socket)
    test_page.goto(f'{BASE_URL}/#live-monitor')
    expect(test_page.locator('.status').nth(1)).to_have_text('ESP32 Online')
    expect(test_page.locator('.stage .gauge-ring strong').first).to_have_text('0.75')
    expect(test_page.locator('.stage .gauge-ring strong').nth(1)).to_have_text('0.80')
    expect(test_page.locator('.live-bottom blockquote')).to_contain_text('Integration test transcript')
    assert '0.0 KB' not in test_page.locator('.runtime-gauges').inner_text()
    assert test_page.locator('.confidence .cyan-line').get_attribute('d') == 'M0,128 L1000,40'
    test_page.get_by_role('button', name='Start microphone test').click()
    test_page.wait_for_timeout(100)
    assert commands == ['KWS_TEST_START']
    snapshot['kws_test'] = {'active': True, 'remaining_ms': 9000}
    sockets[-1].send(json.dumps(snapshot))
    test_page.get_by_role('button', name='Stop test · 9s').click()
    test_page.wait_for_timeout(100)
    assert commands == ['KWS_TEST_START', 'KWS_TEST_STOP']
    snapshot['metrics']['stage2_invoked'] = False
    sockets[-1].send(json.dumps(snapshot))
    expect(test_page.locator('.stage-result').nth(1)).to_have_text('GATED')
    expect(test_page.locator('.stage .gauge-ring strong').nth(1)).to_have_text('--')
    test_page.get_by_role('link', name='Dataset', exact=True).click()
    expect(test_page.locator('.donut strong')).to_have_text('9,528')
    expect(test_page.locator('.hard-negative-list')).to_contain_text('MARTIN')
    expect(test_page.locator('.dataset-details')).to_contain_text('9,528')
    sockets[-1].close()
    expect(test_page.locator('.status').nth(1)).to_have_text('ESP32 Offline')
    expect(test_page.locator('.donut strong')).to_have_text('9,528')
    test_page.get_by_role('link', name='Live Monitor', exact=True).click()
    expect(test_page.get_by_role('button', name='Start microphone test')).to_be_disabled()
    expect(test_page.locator('.stage .gauge-ring strong').first).to_have_text('--')
    test_page.close()
    return 'Passed: scores, transcripts, gating, null metrics, test commands, static corpus, and disconnection.'

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1536, 'height': 1024}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    failed_assets = set()
    page.on('response', lambda response: failed_assets.add(f'{response.status}: {response.url}') if response.status >= 400 else None)
    report = []
    for width, height in [(1536, 1024), (390, 844), (1024, 768), (768, 1024)]:
        page.set_viewport_size({'width': width, 'height': height})
        for name in PAGES:
            page.goto(f'{BASE_URL}/#{name}')
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUTPUT / f'{name}-{width}.png'), full_page=width != 1536)
            report.append({'page': name, 'width': width, **page.evaluate('''() => ({
                scrollWidth: document.documentElement.scrollWidth,
                height: document.documentElement.scrollHeight,
                layout: [...document.querySelectorAll('.app, .workspace, main, footer')].map(element => ({name: element.className || element.tagName, height: element.getBoundingClientRect().height, top: element.getBoundingClientRect().top, rows: getComputedStyle(element).gridTemplateRows})),
                overflow: [...document.querySelectorAll('main .panel')].filter(element => element.scrollWidth > element.clientWidth + 2).map(element => ({title: element.querySelector('h2')?.textContent, width: element.clientWidth, scroll: element.scrollWidth})),
                navigation: [...document.querySelectorAll('nav a')].map(element => element.textContent)
            })''')})
    assets = page.evaluate('''async () => {
        const url = getComputedStyle(document.querySelector('.header-earth')).backgroundImage;
        const response = await fetch(url.slice(5, -2));
        return {url, status: response.status, type: response.headers.get('content-type'), body: response.headers.get('content-type')?.includes('text') ? (await response.text()).slice(0, 300) : ''};
    }''')
    backend_check = verify_backend(browser)
    browser.close()
    (OUTPUT / 'report.json').write_text(json.dumps({'errors': errors, 'assets': assets, 'failed_assets': list(failed_assets), 'backend_check': backend_check, 'pages': report}, indent=2))
    print(json.dumps({'errors': errors, 'assets': assets, 'failed_assets': list(failed_assets), 'backend_check': backend_check, 'overflow': [result for result in report if result['overflow'] or result['scrollWidth'] > result['width']]}, indent=2))

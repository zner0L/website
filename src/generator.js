import preact from 'preact';
import RequestForm from 'Forms/RequestForm';
import Letter from 'Utility/Letter';
import { SearchBar } from './Components/SearchBar';
import { IntlProvider, Text } from 'preact-i18n';
import t from 'Utility/i18n';
import { fetchCompanyDataBySlug } from 'Utility/companies';
import localforage from 'localforage';
import Privacy, { PRIVACY_ACTIONS } from './Utility/Privacy';
import Modal from './Components/Modal';
import { ErrorException, isDebugMode, rethrow } from './Utility/errors';
import CompanyWidget from './Components/CompanyWidget';
import IdData, { deepCopyObject, ID_DATA_CHANGE_EVENT, ID_DATA_CLEAR_EVENT } from './Utility/IdData';
import { SavedCompanies } from './Components/Wizard';
import { t_r } from './Utility/i18n';
import Joyride from 'react-joyride';
import { tutorial_steps } from './wizard-tutorial.js';
import Cookie from 'js-cookie';

const request_articles = { access: 15, erasure: 17, rectification: 16 };

const HIDE_IN_WIZARD_MODE = [
    '.search',
    '.request-type-chooser',
    '#data-portability',
    '#advanced-information',
    '.company-remove'
];

class Generator extends preact.Component {
    constructor(props) {
        super(props);

        this.state = {
            request_data: this.freshRequestData(),
            template_text: '',
            suggestion: null,
            download_active: false,
            blob_url: '',
            download_filename: '',
            batch: [],
            modal_showing: '',
            response_type: '',
            fill_fields: [],
            fill_signature: null,
            response_request: {},
            request_done: false, // TODO: Maybe change according to #98
            run_wizard_tutorial: false
        };

        this.database_url = BASE_URL + 'db/';
        this.letter = new Letter({});

        if (Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_MY_REQUESTS)) {
            // TODO: Is there a better place for this?
            this.request_store = localforage.createInstance({
                name: 'Datenanfragen.de',
                storeName: 'my-requests'
            });
        }
        if (Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_ID_DATA)) {
            this.idData = new IdData();
            this.idData.getAll(false).then(fill_fields => this.setState({ fill_fields: fill_fields }));
            this.idData.getSignature().then(fill_signature => this.setState({ fill_signature: fill_signature }));
        }

        this.renderRequest = this.renderRequest.bind(this);
        this.handleInputChange = this.handleInputChange.bind(this);
        this.handleAutocompleteSelected = this.handleAutocompleteSelected.bind(this);
        this.handleTypeChange = this.handleTypeChange.bind(this);
        this.handleLetterChange = this.handleLetterChange.bind(this);
        this.handleLetterTemplateChange = this.handleLetterTemplateChange.bind(this);
        this.handleTransportMediumChange = this.handleTransportMediumChange.bind(this);
        this.storeRequest = this.storeRequest.bind(this);
        this.newRequest = this.newRequest.bind(this);
        this.hideModal = this.hideModal.bind(this);
        this.tutorialCallback = this.tutorialCallback.bind(this);

        this.pdfWorker = new Worker(BASE_URL + 'js/pdfworker.gen.js');
        this.pdfWorker.onmessage = message => {
            this.setState({
                blob_url: message.data,
                download_filename:
                    (this.state.suggestion !== null
                        ? this.state.suggestion['slug']
                        : slugify(this.state.request_data.recipient_address.split('\n', 1)[0] || 'custom-recipient')) +
                    '_' +
                    this.state.request_data['type'] +
                    '_' +
                    this.state.request_data['reference'] +
                    '.pdf',
                download_active: true
            });
        };
        this.pdfWorker.onerror = error => {
            rethrow(error, 'PdfWorker error');
        };

        if (Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_WIZARD_ENTRIES)) this.saved_companies = new SavedCompanies();
        if (findGetParameter('from') === 'wizard') {
            if (Cookie.get('finished_wizard_tutorial') !== 'true') this.state.run_wizard_tutorial = true;

            if (Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_WIZARD_ENTRIES)) {
                this.saved_companies.getAll().then(companies => {
                    this.setState({ batch: Object.keys(companies) });
                    if (this.state.batch && this.state.batch.length > 0) {
                        fetchCompanyDataBySlug(this.state.batch.shift(), company => {
                            this.setCompany(company);
                        });
                    }
                });
            } else {
                let batch_companies = findGetParameter('companies');
                if (batch_companies) {
                    this.setState({ batch: batch_companies.split(',') });
                }
            }
        }

        this.resetInitialConditions();
    }

    freshRequestData() {
        let today = new Date();

        return {
            type: 'access',
            transport_medium: 'fax',
            id_data: deepCopyObject(defaultFields(LOCALE)),
            reference: Letter.generateReference(today),
            date: today.toISOString().substring(0, 10),
            recipient_address: '',
            signature: { type: 'text', value: '' },
            erase_all: true,
            erasure_data: '',
            data_portability: false,
            recipient_runs: [],
            rectification_data: [],
            information_block: '',
            custom_data: {
                content: '',
                subject: '',
                sender_address: {},
                name: ''
            },
            language: LOCALE
        };
    }

    resetInitialConditions() {
        if (this.state.batch && this.state.batch.length > 0) {
            fetchCompanyDataBySlug(this.state.batch.shift(), company => {
                this.setCompany(company);
            });
        }

        if (Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_MY_REQUESTS)) {
            let response_to = findGetParameter('response_to');
            let response_type = findGetParameter('response_type');
            if (response_to && response_type) {
                this.request_store.getItem(response_to).then(request => {
                    fetch(templateURL(this.state.request_data.language) + response_type + '.txt')
                        .then(res => res.text())
                        .then(text => {
                            this.setState(prev => {
                                prev.request_data.custom_data['content'] = Letter.handleTemplate(text, [], {
                                    request_article: request_articles[request.type],
                                    request_date: request.date,
                                    request_recipient_address: request.recipient
                                });
                                if (response_type === 'admonition') {
                                    prev.request_data['via'] = request.via;
                                    prev.request_data['recipient_address'] = request.recipient;
                                }
                                prev.request_data['reference'] = request.reference;
                                prev.response_type = response_type;
                                prev.request_data['type'] = 'custom';
                                prev.response_request = request;
                                return prev;
                            });
                            if (response_type === 'admonition' && request.slug)
                                fetchCompanyDataBySlug(request.slug, company => {
                                    this.setCompany(company);
                                });
                            this.renderRequest();
                        });
                });
                if (response_type === 'complaint') this.showModal('choose_authority');
            }
        }

        fetch(templateURL(this.state.request_data.language) + 'access-default.txt')
            .then(res => res.text())
            .then(text => {
                this.setState({ template_text: text });
                this.renderRequest();

                if (Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_ID_DATA) && IdData.shouldAlwaysFill()) {
                    this.idData.getAllFixed().then(fill_data => {
                        this.setState(prev => {
                            prev.request_data['id_data'] = IdData.mergeFields(
                                prev.request_data['id_data'],
                                fill_data,
                                true,
                                true,
                                true,
                                true
                            );
                            return prev;
                        });
                        this.renderRequest();
                    });
                    this.idData.getSignature().then(signature => {
                        if (signature) {
                            this.setState(prev => {
                                prev.request_data['signature'] = signature;
                                return prev;
                            });
                            this.renderRequest();
                        }
                    });
                    this.idData.getFixed('name').then(name =>
                        this.setState(prev => {
                            if (name) prev.request_data['custom_data']['name'] = name.value;
                            return prev;
                        })
                    );
                    this.idData.getFixed('address').then(address =>
                        this.setState(prev => {
                            if (address) prev.request_data['custom_data']['sender_address'] = address.value;
                            return prev;
                        })
                    );
                }
            });
    }

    tutorialCallback(data) {
        if (data.type == 'finished') Cookie.set('finished_wizard_tutorial', 'true', { expires: 365 });
    }

    render() {
        let company_widget = '';
        let new_request_text = 'new-request';
        if (this.state.batch && this.state.batch.length > 0) new_request_text = 'next-request';
        if (this.state.suggestion !== null) {
            company_widget = (
                <CompanyWidget
                    company={this.state.suggestion}
                    onRemove={() =>
                        this.setState(prev => {
                            prev['suggestion'] = null;
                            prev.request_data['recipient_runs'] = [];
                            prev.request_data['language'] = LOCALE;
                            return prev;
                        })
                    }
                />
            );
        }

        return (
            <main>
                <Joyride
                    ref={c => (this.tutorial = c)}
                    callback={this.tutorialCallback}
                    steps={tutorial_steps}
                    type="continuous"
                    run={this.state.run_wizard_tutorial}
                    autoStart={true}
                    locale={{
                        back: t('back', 'wizard_tutorial'),
                        close: t('close', 'wizard_tutorial'),
                        last: t('finish', 'wizard_tutorial'),
                        next: t('next', 'wizard_tutorial'),
                        skip: t('skip', 'wizard_tutorial')
                    }}
                    showSkipButton={true}
                    showStepsProgress={true}
                    showOverlay={false}
                />

                {this.state.modal_showing}
                <header id="generator-header">
                    <div id="generator-controls" style="margin-bottom: 10px;">
                        {this.getActionButton()}
                        <button
                            className="button-secondary"
                            id="new-request-button"
                            onClick={() => {
                                if (!this.state.request_done) this.showModal('new_request');
                                else this.newRequest();
                            }}>
                            <Text id={new_request_text} />
                        </button>
                    </div>
                </header>
                <div className="clearfix" />
                <div class="search">
                    <SearchBar
                        id="aa-search-input"
                        index="companies"
                        onAutocompleteSelected={this.handleAutocompleteSelected}
                        placeholder={t('select-company', 'generator')}
                        debug={false}
                    />
                    {/* For some reason, autocomplete.js completely freaks out if it is wrapped in any tag at all and there isn't *anything at all* after it (only in the generator, though). As a workaround, we just use a space. We are counting on #24 anyway… */}{' '}
                </div>
                <div id="request-generator" className="grid" style="margin-top: 10px;">
                    <div id="form-container">
                        <RequestForm
                            onChange={this.handleInputChange}
                            onTypeChange={this.handleTypeChange}
                            onLetterChange={this.handleLetterChange}
                            onTransportMediumChange={this.handleTransportMediumChange}
                            request_data={this.state.request_data}
                            fillFields={this.state.fill_fields}
                            fillSignature={this.state.fill_signature}
                            onLetterTemplateChange={this.handleLetterTemplateChange}>
                            {company_widget}
                        </RequestForm>
                    </div>
                    {isDebugMode() ? (
                        <div id="content-container" className="box">
                            <iframe
                                id="pdf-viewer"
                                src={this.state.blob_url}
                                className={this.state.blob_url ? '' : 'empty'}
                            />
                        </div>
                    ) : (
                        []
                    )}
                </div>
                <div className="clearfix" />
            </main>
        );
    }

    adjustAccordingToWizardMode() {
        let wizard = findGetParameter('from') === 'wizard';

        HIDE_IN_WIZARD_MODE.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                if (wizard) el.classList.add('hidden');
                else el.classList.remove('hidden');
            });
        });
        document.querySelectorAll('.company-info h1').forEach(selector => {
            selector.style.marginLeft = wizard ? '0' : '';
        });
    }

    componentDidUpdate() {
        this.adjustAccordingToWizardMode();
    }

    componentDidMount() {
        this.adjustAccordingToWizardMode();

        if (Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_ID_DATA)) {
            window.addEventListener(ID_DATA_CHANGE_EVENT, event => {
                this.idData.getAll(false).then(fill_fields => this.setState({ fill_fields: fill_fields }));
                this.idData.getSignature().then(fill_signature => this.setState({ fill_signature: fill_signature }));
            });
            window.addEventListener(ID_DATA_CLEAR_EVENT, event => {
                this.idData.getAll(false).then(fill_fields => this.setState({ fill_fields: fill_fields }));
                this.idData.getSignature().then(fill_signature => this.setState({ fill_signature: fill_signature }));
            });
        }
    }

    /**
     *
     * @param modal {string|Component} if it is a string, modal will be interpreted as modal_id
     */
    showModal(modal) {
        if (typeof modal === 'string') {
            let modal_id = modal;
            switch (modal_id) {
                case 'new_request': // TODO: Logic
                    modal = (
                        <Modal
                            positiveText={[
                                t(
                                    this.state.request_data.transport_medium === 'email'
                                        ? 'send-email-first'
                                        : 'download-pdf-first',
                                    'generator'
                                ),
                                <span
                                    style="margin-left: 10px;"
                                    className={
                                        'icon ' +
                                        (this.state.request_data.transport_medium === 'email'
                                            ? 'icon-email'
                                            : 'icon-download')
                                    }
                                />
                            ]}
                            negativeText={t('new-request', 'generator')}
                            onNegativeFeedback={e => {
                                this.hideModal();
                                this.newRequest();
                            }}
                            onPositiveFeedback={e => {
                                if (this.state.blob_url) {
                                    this.hideModal();
                                    this.storeRequest();
                                    download(
                                        this.state.request_data.transport_medium === 'email'
                                            ? this.getMailtoLink()
                                            : this.state.blob_url,
                                        this.state.request_data.transport_medium === 'email'
                                            ? null
                                            : this.state.download_filename
                                    );
                                    this.newRequest();
                                }
                            }}
                            positiveDefault={true}
                            onDismiss={this.hideModal}>
                            <Text id="modal-new-request" />
                        </Modal>
                    );
                    break;
                case 'choose_authority':
                    modal = (
                        <Modal
                            negativeText={t('cancel', 'generator')}
                            onNegativeFeedback={() => this.hideModal()}
                            positiveDefault={true}
                            onDismiss={() => this.hideModal()}>
                            <Text id="modal-select-authority" />
                            <SearchBar
                                id="aa-authority-search-input"
                                index="supervisory-authorities"
                                query_by="name"
                                disableCountryFiltering={true}
                                onAutocompleteSelected={(event, suggestion, dataset) => {
                                    this.setCompany(suggestion.document);
                                    fetch(templateURL(suggestion.document['complaint-language']) + 'complaint.txt')
                                        .then(res => res.text())
                                        .then(text => {
                                            this.setState(prev => {
                                                prev.request_data.custom_data['content'] = Letter.handleTemplate(
                                                    text,
                                                    [],
                                                    {
                                                        request_article:
                                                            request_articles[this.state.response_request.type],
                                                        request_date: this.state.response_request.date,
                                                        request_recipient_address: this.state.response_request.recipient
                                                    }
                                                );
                                            });
                                            this.renderRequest();
                                        });
                                    this.hideModal();
                                }}
                                placeholder={t('select-authority', 'generator')}
                                debug={true}
                                style="margin-top: 15px;"
                                suggestion_template={suggestion => {
                                    let name_hs = suggestion.highlights.filter(a => a.field === 'name');
                                    return (
                                        '<span><strong>' +
                                        (name_hs.length === 1 ? name_hs[0].snippet : suggestion.document.name) +
                                        '</strong></span>'
                                    );
                                }}
                                empty_template={'<p style="margin-left: 10px;">' + t('no-results', 'search') + '</p>'}
                            />{' '}
                            {/* TODO: Only show relevant countries */}
                        </Modal>
                    );
            }
        }
        this.setState({ modal_showing: modal });
    }

    hideModal() {
        this.setState({ modal_showing: '' });
    }

    getActionButton() {
        let action_button = (
            <a
                id="download-button"
                className={'button' + (this.state.download_active ? '' : ' disabled') + ' button-primary'}
                href={this.state.blob_url}
                download={this.state.download_filename}
                onClick={e => {
                    if (!this.state.download_active) {
                        e.preventDefault();
                    } else {
                        this.storeRequest();
                        this.setState({ request_done: true });
                    }
                }}>
                <Text id="download-pdf" />
                &nbsp;&nbsp;
                <span className="icon icon-download" />
            </a>
        );

        if (this.state.request_data.transport_medium === 'email') {
            action_button = (
                <a
                    id="sendmail-button"
                    className={'button' + (this.state.blob_url ? '' : ' disabled') + ' button-primary'}
                    href={this.getMailtoLink()}
                    onClick={e => {
                        if (!this.state.blob_url) {
                            e.preventDefault();
                        } else {
                            this.storeRequest();
                            this.setState({ request_done: true });
                        }
                    }}>
                    <Text id="send-email" />
                    &nbsp;&nbsp;
                    <span className="icon icon-email" />
                </a>
            );
        }

        return action_button;
    }

    getMailtoLink() {
        return (
            'mailto:' +
            (this.state.suggestion && this.state.suggestion['email'] ? this.state.suggestion['email'] : '') +
            '?' +
            'subject=' +
            encodeURIComponent(this.letter.props.subject) +
            ' (' +
            t_r('my-reference', this.letter.props.language) +
            ': ' +
            this.letter.props.reference +
            ')' +
            '&body=' +
            encodeURIComponent(this.letter.toEmailString())
        );
    }

    setCompany(company) {
        let template_file =
            company['custom-' + this.state.request_data.type + '-template'] ||
            this.state.request_data.type + '-default.txt';
        fetch(templateURL(company['request-language']) + template_file)
            .then(res => res.text())
            .then(text => {
                this.setState({ template_text: text });
                this.renderRequest();
            });

        this.setState(prev => {
            prev.request_data['transport_medium'] = company['suggested-transport-medium']
                ? company['suggested-transport-medium']
                : company['fax']
                    ? 'fax'
                    : 'letter';
            prev.request_data['recipient_address'] =
                company.name +
                '\n' +
                company.address +
                (prev.request_data['transport_medium'] === 'fax'
                    ? '\n' + t('by-fax', 'generator') + company['fax']
                    : '');
            prev.request_data['id_data'] = IdData.mergeFields(
                prev.request_data['id_data'],
                !!company['required-elements'] && company['required-elements'].length > 0
                    ? company['required-elements']
                    : defaultFields(
                          !!company['request-language'] && company['request-language'] !== ''
                              ? company['request-language']
                              : LOCALE
                      )
            );
            prev.request_data['recipient_runs'] = company.runs || [];
            prev.suggestion = company;
            prev.request_data['data_portability'] = company['suggested-transport-medium'] === 'email';
            prev.request_data['language'] = company['request-language'] || LOCALE;
            return prev;
        });
    }

    handleAutocompleteSelected(event, suggestion, dataset) {
        if (this.state.suggestion) {
            this.showModal(
                <Modal
                    positiveText={t('new-request', 'generator')}
                    negativeText={t('override-request', 'generator')}
                    onNegativeFeedback={e => {
                        this.hideModal();
                        this.setCompany(suggestion.document);
                        this.renderRequest();
                    }}
                    onPositiveFeedback={e => {
                        this.hideModal();
                        this.newRequest();
                        this.setCompany(suggestion.document);
                        this.renderRequest();
                    }}
                    positiveDefault={true}
                    onDismiss={this.hideModal}>
                    <Text id="modal-autocomplete-new-request" />
                </Modal>
            );
        } else {
            this.setCompany(suggestion.document);
            this.renderRequest();
        }
    }

    handleTypeChange(event) {
        this.handleInputChange({ type: event.target.value });
        if (event.target.value === 'custom') {
            this.letter.clearProps();
            this.letter.updateDoc();
            return;
        }
        let template_file = this.state.suggestion
            ? this.state.suggestion['custom-' + this.state.request_data.type + '-template'] ||
              this.state.request_data.type + '-default.txt'
            : this.state.request_data.type + '-default.txt';
        fetch(templateURL(this.state.request_data.language) + template_file)
            .then(res => res.text())
            .then(text => {
                this.setState({ template_text: text });
                this.renderRequest();
            });
    }

    handleInputChange(changed_data) {
        this.setState(prev => {
            for (let key in changed_data) {
                prev['request_data'][key] = changed_data[key];
            }
            return prev;
        });
        this.renderRequest();
    }

    handleLetterChange(event, address_change = false) {
        if (address_change) {
            this.setState(prev => {
                let att = event.target.getAttribute('name');
                prev.request_data.custom_data['sender_address'][att] = event.target.value;
                return prev;
            });
        } else {
            this.setState(prev => {
                let att = event.target.getAttribute('name');
                if (prev.request_data.custom_data.hasOwnProperty(att))
                    prev.request_data.custom_data[att] = event.target.value;
                return prev;
            });
        }
        this.renderRequest();
    }

    handleLetterTemplateChange(event) {
        if (event.target.value && event.target.value !== 'no-template') {
            fetch(templateURL(this.state.request_data.language) + event.target.value + '.txt')
                .then(res => res.text())
                .then(text => {
                    this.setState(prev => {
                        prev.request_data.custom_data['content'] = text;
                        prev.response_type = event.target.value;
                        return prev;
                    });
                    this.renderRequest();
                });
        } else if (event.target.value === 'no-template') {
            this.setState({ response_type: '' });
        }
    }

    handleTransportMediumChange(event) {
        // TODO: Warning when sending via email
        this.setState(prev => {
            prev['request_data']['transport_medium'] = event.target.value;
            switch (event.target.value) {
                case 'fax':
                    if (
                        prev['suggestion'] &&
                        !prev['request_data']['recipient_address'].includes(t('by-fax', 'generator'))
                    )
                        prev['request_data']['recipient_address'] +=
                            '\n' + t('by-fax', 'generator') + (prev['suggestion']['fax'] || '');
                    break;
                case 'letter':
                case 'email':
                    prev['request_data']['recipient_address'] = prev['request_data']['recipient_address'].replace(
                        new RegExp('(?:\\r\\n|\\r|\\n)' + t('by-fax', 'generator') + '\\+?[0-9\\s]*', 'gm'),
                        ''
                    );
                    break;
            }

            prev['request_data']['data_portability'] = event.target.value === 'email';

            return prev;
        });
        this.renderRequest();
    }

    newRequest() {
        // TODO: Make sure this ends up in the new canonical place for completed requests, as per #90 (i.e. when the request is saved to 'My requests').
        if (
            this.state.request_data.type === 'access' &&
            Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_WIZARD_ENTRIES) &&
            this.state.suggestion &&
            this.state.suggestion['slug']
        )
            this.saved_companies.remove(this.state.suggestion['slug']);

        // TODO: Same for this.
        if (findGetParameter('from') === 'wizard' && this.state.batch && this.state.batch.length === 0) {
            // Remove the GET parameters from the URL so this doesn't get triggered again on the next new request and get the generator out of wizard-mode.
            window.history.pushState({}, document.title, BASE_URL + 'generator');
            this.adjustAccordingToWizardMode();
            this.showModal(
                <Modal
                    positiveText={t('ok', 'generator')}
                    onPositiveFeedback={this.hideModal}
                    positiveDefault={true}
                    onDismiss={this.hideModal}>
                    <Text id="wizard-done-modal" />
                </Modal>
            );
        }

        this.setState(prev => {
            prev['request_data'] = this.freshRequestData();
            prev['suggestion'] = null;
            prev['download_active'] = false;
            prev['blob_url'] = '';
            prev['download_filename'] = '';
            prev['response_type'] = '';
            prev['request_done'] = false;
            return prev;
        });

        this.resetInitialConditions();
    }

    renderRequest() {
        if (this.state.request_data['type'] === 'custom') {
            let signature = this.state.request_data['signature'];
            signature['name'] = this.state.request_data.custom_data['name'];
            this.letter.setProps({
                subject: this.state.request_data.custom_data['subject'],
                content: this.state.request_data.custom_data['content'],
                signature: signature,
                recipient_address: this.state.request_data['recipient_address'],
                sender_oneline: Letter.formatAddress(
                    this.state.request_data.custom_data['sender_address'],
                    ' • ',
                    this.state.request_data.custom_data['name']
                ),
                information_block: Letter.makeInformationBlock(this.state.request_data),
                reference_barcode: Letter.barcodeFromText(this.state.request_data.reference)
            });
        } else this.letter.setProps(Letter.propsFromRequest(this.state.request_data, this.state.template_text));

        switch (this.state.request_data['transport_medium']) {
            case 'fax':
            case 'letter':
                this.setState({ download_active: false });
                this.pdfWorker.postMessage(this.letter.toPdfDoc());
                break;
            case 'email':
                let email_blob = new Blob(
                    [
                        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><pre style="white-space: pre-line;">' +
                            this.letter.toEmailString(true) +
                            '</pre></body>'
                    ],
                    {
                        type: 'text/html'
                    }
                );
                this.setState({ blob_url: URL.createObjectURL(email_blob) });
                break;
        }
    }

    storeRequest() {
        if (Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_ID_DATA)) {
            this.idData.storeArray(this.state.request_data['id_data']);
            this.idData.storeSignature(this.state.request_data['signature']);
        }
        if (Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_MY_REQUESTS)) {
            let request = this.state.request_data;
            let db_id =
                request.reference +
                '-' +
                request.type +
                (request.type === 'custom' && this.state.response_type ? '-' + this.state.response_type : '');
            this.request_store
                .setItem(db_id, {
                    reference: request.reference,
                    date: request.date,
                    type: request.type,
                    response_type: this.state.response_type,
                    slug: this.state.suggestion ? this.state.suggestion['slug'] : null,
                    recipient: request.recipient_address,
                    via: request.transport_medium
                })
                .catch(error => {
                    rethrow(error, 'Saving request failed.', { database_id: db_id });
                });
        }
    }
}

// taken from https://gist.github.com/mathewbyrne/1280286
function slugify(text) {
    return text
        .toString()
        .toLowerCase()
        .replace(/\s+/g, '-') // Replace spaces with -
        .replace(/[^\w\-]+/g, '') // Remove all non-word chars
        .replace(/\-\-+/g, '-') // Replace multiple - with single -
        .replace(/^-+/, '') // Trim - from start of text
        .replace(/-+$/, ''); // Trim - from end of text
}

function findGetParameter(param) {
    let tmp = [];
    let result = null;
    location.search
        .substr(1)
        .split('&')
        .forEach(item => {
            tmp = item.split('=');
            if (tmp[0] === param) return (result = decodeURIComponent(tmp[1]));
        });
    return result;
}

function templateURL(locale = LOCALE) {
    if (!Object.keys(I18N_DEFINITION_REQUESTS).includes(locale)) locale = LOCALE;
    return BASE_URL + 'templates/' + (locale || LOCALE) + '/';
}

function defaultFields(locale = LOCALE) {
    return [
        {
            desc: t_r('name', locale),
            type: 'name',
            optional: true,
            value: ''
        },
        {
            desc: t_r('birthdate', locale),
            type: 'birthdate',
            optional: true,
            value: ''
        },
        {
            desc: t_r('address', locale),
            type: 'address',
            optional: true,
            value: { primary: true }
        }
    ];
}

// Apparently, triggering a download in JavaScript is very hard
// inspired by: https://ourcodeworld.com/articles/read/189/how-to-create-a-file-and-generate-a-download-with-javascript-in-the-browser-without-a-server
function download(url, filename) {
    let element = document.createElement('a');
    element.setAttribute('href', url);
    if (filename) element.setAttribute('download', filename);

    element.style.display = 'none';
    document.body.appendChild(element);

    element.click();

    document.body.removeChild(element);
}

preact.render(
    <IntlProvider scope="generator" definition={I18N_DEFINITION}>
        <Generator />
    </IntlProvider>,
    null,
    document.getElementById('generator')
);

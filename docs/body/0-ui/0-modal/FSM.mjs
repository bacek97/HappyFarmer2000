class GameModal {
    constructor(options) {
        this.id = options.id;
        this.title = options.title || 'Модальное окно';
        this.tabs = options.tabs || null; // массив {name, content} или null
        this.content = options.content || ''; // для простых модалок без вкладок
        this.onOpen = options.onOpen || null;
        this.onClose = options.onClose || null;

        this._createModal(options.parent);
    }

    _createModal(parent) {
        const template = document.getElementById('modal-template');
        const templateContent = template.content.cloneNode(true);
        const dialog = templateContent.querySelector('dialog');

        // Применяем стили из template
        const styleEl = templateContent.querySelector('style');
        if (styleEl && !document.getElementById('modal-styles')) {
            styleEl.id = 'modal-styles';
            document.head.appendChild(styleEl);
        }

        dialog.id = this.id;

        // Заполняем заголовок
        const header = dialog.querySelector('.modal-header');
        const titleSlot = header.querySelector('slot[name="title"]');
        titleSlot.outerHTML = `<h2>${this.title}</h2>`;

        // Заполняем вкладки или удаляем слот
        const tabsSlot = header.querySelector('slot[name="tabs"]');
        if (this.tabs?.length) {
            dialog.classList.add('tabs-container');
            const tabs = document.createElement('div');
            tabs.className = 'tabs';
            this.tabs.forEach((tab, i) => {
                const el = document.createElement('div');
                el.className = 'tab' + (i === 0 ? ' active' : '');
                el.textContent = tab.name;
                tabs.appendChild(el);
            });

            tabsSlot.replaceWith(tabs);
        } else {
            tabsSlot.remove();
        }

        // Заполняем контент
        const body = dialog.querySelector('.modal-body');
        const contentSlot = body.querySelector('slot[name="content"]');

        if (this.tabs && this.tabs.length > 0) {
            const contentsHtml = this.tabs.map((tab, i) =>
                `<div class="tab-content${i === 0 ? ' active' : ''}">${tab.content}</div>`
            ).join('');
            contentSlot.outerHTML = contentsHtml;
        } else {
            contentSlot.outerHTML = this.content;
        }

        // Кнопка закрытия
        const closeBtn = dialog.querySelector('.close-x');
        closeBtn.addEventListener('click', () => this.close());

        // Закрытие по клику на backdrop
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                this.close();
            }
        });

        parent.appendChild(dialog);
        this.dialog = dialog;

        // Инициализация вкладок
        if (this.tabs && this.tabs.length > 0) {
            this._initTabs();
            this._initSwipe();
        }
    }

    _initTabs() {
        const tabs = this.dialog.querySelectorAll('.tab');
        tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => this.switchTab(index));
        });
    }

    _initSwipe() {
        const body = this.dialog.querySelector('.modal-body');
        if (!body) return;

        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;
        const minSwipeDistance = 50;
        const maxSwipeTime = 400;

        body.addEventListener('touchstart', (e) => {
            if (e.touches.length > 1) return;
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
            touchStartTime = Date.now();
        }, { passive: true });

        body.addEventListener('touchend', (e) => {
            const touchEndX = e.changedTouches[0].screenX;
            const touchEndY = e.changedTouches[0].screenY;
            const touchEndTime = Date.now();

            if ((touchEndTime - touchStartTime) > maxSwipeTime) return;

            const distanceX = touchEndX - touchStartX;
            const distanceY = touchEndY - touchStartY;

            if (Math.abs(distanceY) > Math.abs(distanceX) * 0.4) return;
            if (Math.abs(distanceX) < minSwipeDistance) return;

            const tabs = this.dialog.querySelectorAll('.tab');
            const activeIndex = Array.from(tabs).findIndex(t => t.classList.contains('active'));
            const current = activeIndex === -1 ? 0 : activeIndex;
            let nextIndex;

            if (distanceX > 0) {
                nextIndex = (current - 1 + tabs.length) % tabs.length;
            } else {
                nextIndex = (current + 1) % tabs.length;
            }

            this.switchTab(nextIndex);
        }, { passive: true });
    }

    switchTab(index) {
        const tabs = this.dialog.querySelectorAll('.tab');
        const contents = this.dialog.querySelectorAll('.tab-content');

        tabs.forEach(tab => tab.classList.remove('active'));
        contents.forEach(content => content.classList.remove('active'));

        if (tabs[index]) tabs[index].classList.add('active');
        if (contents[index]) contents[index].classList.add('active');
    }

    open() {
        if (this.dialog) {
            this.dialog.showModal();
            if (this.onOpen) this.onOpen();
        }
    }

    close() {
        if (this.dialog) {
            this.dialog.close();
            if (this.onClose) this.onClose();
        }
    }
}

export { GameModal };


const template = `
    <template id="modal-template">
        <dialog class="game-modal">
            <div class="modal-header">
                <slot name="title">
                    <h2>Заголовок</h2>
                </slot>
                <slot name="tabs"></slot>
                <button class="close-x">&times;</button>
            </div>
            <div class="modal-body">
                <slot name="content">Содержимое модального окна</slot>
            </div>
        </dialog>
    </template>
`;

const style = `
   <style>
        /* 2. СТИЛИ МОДАЛОК В СТИЛЕ ИГРЫ */
        dialog.game-modal {
            border: 2px solid #ddd;
            border-radius: 25px;
            padding: 0;
            box-shadow: 0 0 0 5px rgba(255, 255, 255, 0.2), 0 15px 35px rgba(0, 0, 0, 0.4);
            max-width: 90%;
            width: 550px;
            background: #fdfdfd;
            overflow: hidden;
            will-change: transform;
        }

        dialog.game-modal::backdrop {
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(3px);
        }

        /* Хедер */
        .modal-header {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 10px 20px;
            padding-bottom: 0;
            border-bottom: 1px solid #ccc;
            position: relative;
        }

        .modal-header h2,
        .modal-header h3 {
            margin-top: 5px;
            margin-bottom: 10px;
            /* font-size: 1.1rem; */
            color: #333;
            font-weight: bold;
        }

        /* Контейнер вкладок */
        .tabs {
            display: flex;
            gap: 4px;
            width: 100%;
            /* justify-content: center; */
            margin-bottom: -1px;
            /* font-size: 16px; */
            overflow-x: scroll;
            scrollbar-width: none;

        }

        /* Стили вкладок */
        .tab {
            background: transparent;
            border: 1px solid #c0c0c0;
            border-bottom: none;
            border-radius: 6px 6px 0 0;
            padding: 6px 16px;
            color: #0056b3;
            font-weight: bold;
            cursor: pointer;
            position: relative;
            transition: background 0.2s;
        }

        .tab:hover {
            background: rgba(0, 86, 179, 0.05);
        }

        .tab.active {
            background: #fdfdfd;
            border-bottom: 1px solid #fdfdfd;
            z-index: 2;
        }

        /* Кнопка закрытия */
        .close-x {
            position: absolute;
            right: 15px;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            color: #666;
            font-size: 2rem;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            background: none;
            border: none;
        }

        .close-x:hover {
            color: #000;
        }

        /* Тело модалки со скроллом */
        .modal-body {
            padding: 20px;
            padding-right: 30px;
            margin-right: 6px;
            max-height: 250px;
            overflow-y: auto;
            color: #444;
            will-change: transform;
        }

        /* --- СКРОЛЛБАР «ФЕРМА» --- */
        .modal-body::-webkit-scrollbar {
            width: 16px;
        }

        .modal-body::-webkit-scrollbar-track {
            background-color: transparent;
            background-image: linear-gradient(to right, transparent 7px, #ccc 7px, #ccc 9px, transparent 9px);
            margin: 15px 0;
        }

        .modal-body::-webkit-scrollbar-thumb {
            background-clip: padding-box;
            min-height: 80px;
            background-color: #f0f0f0;
            background-image:
                linear-gradient(to bottom,
                    transparent calc(50% - 4px),
                    #999 calc(50% - 4px), #999 calc(50% - 3px),
                    transparent calc(50% - 3px), transparent calc(50% - 1px),
                    transparent 50%, transparent calc(50% + 2px),
                    #999 calc(50% + 2px), #999 calc(50% + 3px),
                    transparent calc(50% + 3px)),
                linear-gradient(to right,
                    #ffffff 55%,
                    #d0d0d0 100%);
            border: 1px solid #bbb;
            border-radius: 10px;
            margin-right: 4px;
            margin-left: 2px;
            box-shadow: inset 0px 0px 3px 1px rgba(0, 0, 0, 0.5);
            background-clip: padding-box;
            cursor: pointer;
        }

        .modal-body::-webkit-scrollbar-thumb:hover {
            background-color: #fff;
        }

        .btn-action {
            background: linear-gradient(to bottom, #ffffff 0%, #f2f2f2 100%);
            color: #0056b3;
            border: 1px solid #c0c0c0;
            padding: 8px 12px;
            border-radius: 6px;
            cursor: pointer;
            width: 100%;
            font-weight: bold;
            font-size: 14px;
            margin-top: 10px;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
            text-shadow: 0 1px 0 rgba(255, 255, 255, 1);
        }

        .btn-action:hover {
            background: linear-gradient(to bottom, #fcfcfc 0%, #e6e6e6 100%);
            border-color: #b0b0b0;
        }

        .btn-action:active {
            background: #e6e6e6;
            box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1);
            transform: translateY(1px);
        }

        /* Контент вкладок */
        .tab-content {
            display: none;
            animation: fadeIn 0.2s ease-in-out;
        }

        .tab-content.active {
            display: block;
        }

        @keyframes fadeIn {
            from {
                opacity: 0;
                transform: translateY(5px);
            }

            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
    </style>
`;

document.head.insertAdjacentHTML('afterbegin', style);
document.body.insertAdjacentHTML('afterbegin', template);